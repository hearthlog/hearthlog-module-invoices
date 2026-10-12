import { SignJWT, importPKCS8 } from 'jose';
import {
    EXTRACTION_RESPONSE_SCHEMA,
    EXTRACTION_SYSTEM_INSTRUCTION,
    EXTRACTION_USER_PROMPT,
} from '../invoices/extraction/prompt.js';
import { isExtractedInvoice } from '../invoices/extraction/schema.js';
import type { ExtractedInvoice } from '../invoices/extraction/types.js';

/**
 * Gemini via Vertex AI (`aiplatform.googleapis.com`). Vertex keeps usage on
 * the normal Google Cloud bill — no prepaid credits — and accepts PDFs
 * directly, so the Worker uploads the document and receives schema-constrained
 * JSON. Authentication is either an express-mode API key or a service account.
 */

const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_LOCATION = 'global';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const REQUEST_TIMEOUT_MS = 60_000;
/** Keep the base64 payload safely under Vertex's 20 MB inline request limit. */
export const MAX_INLINE_PDF_BYTES = 10 * 1024 * 1024;

export interface ServiceAccount {
    clientEmail: string;
    privateKey: string;
    privateKeyId: string;
    projectId: string;
}

export interface VertexExtractionConfig {
    mode: 'api-key' | 'service-account';
    model: string;
    location: string;
    apiKey?: string;
    serviceAccount?: ServiceAccount;
}

export interface VertexEnv {
    INVOICE_EXTRACTION_API_KEY?: string;
    INVOICE_EXTRACTION_SERVICE_ACCOUNT?: string;
    INVOICE_EXTRACTION_MODEL?: string;
    INVOICE_EXTRACTION_LOCATION?: string;
}

export interface VertexExtractionUsage {
    promptTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount: number;
    totalTokenCount: number;
}

export interface VertexExtractionOutput {
    invoice: ExtractedInvoice;
    model: string;
    usage: VertexExtractionUsage | null;
}

export type VertexExtractionErrorCode =
    | 'unauthorized'
    | 'rate_limited'
    | 'timeout'
    | 'invalid_output'
    | 'provider_error'
    | 'empty_response';

export class VertexExtractionError extends Error {
    constructor(
        message: string,
        readonly code: VertexExtractionErrorCode,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'VertexExtractionError';
    }
}

/** Builds a config from Worker/development environment variables, or null when unconfigured. */
export function vertexConfigFromEnv(env: VertexEnv): VertexExtractionConfig | null {
    const model = env.INVOICE_EXTRACTION_MODEL?.trim() || DEFAULT_MODEL;
    const location = env.INVOICE_EXTRACTION_LOCATION?.trim() || DEFAULT_LOCATION;
    const apiKey = env.INVOICE_EXTRACTION_API_KEY?.trim();
    if (apiKey) {
        return { mode: 'api-key', model, location, apiKey };
    }
    const rawServiceAccount = env.INVOICE_EXTRACTION_SERVICE_ACCOUNT?.trim();
    if (rawServiceAccount) {
        const serviceAccount = parseServiceAccount(rawServiceAccount);
        if (serviceAccount) {
            return { mode: 'service-account', model, location, serviceAccount };
        }
    }
    return null;
}

function parseServiceAccount(raw: string): ServiceAccount | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const record = parsed as Record<string, unknown>;
        const clientEmail = typeof record.client_email === 'string' ? record.client_email : '';
        const privateKey = typeof record.private_key === 'string' ? record.private_key : '';
        const projectId = typeof record.project_id === 'string' ? record.project_id : '';
        const privateKeyId = typeof record.private_key_id === 'string' ? record.private_key_id : '';
        if (!clientEmail || !privateKey || !projectId) return null;
        return { clientEmail, privateKey, privateKeyId, projectId };
    } catch {
        return null;
    }
}

/** The `generateContent` endpoint for a config; exported for tests. */
export function vertexEndpoint(config: VertexExtractionConfig): string {
    if (config.mode === 'api-key') {
        return `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey ?? '')}`;
    }
    const host = config.location === 'global' ? 'aiplatform.googleapis.com' : `${config.location}-aiplatform.googleapis.com`;
    const project = config.serviceAccount?.projectId ?? '';
    return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(config.location)}/publishers/google/models/${encodeURIComponent(config.model)}:generateContent`;
}

interface VertexResponsePart {
    text?: string;
    thought?: boolean;
}

interface VertexGenerateContentResponse {
    candidates?: Array<{
        content?: { parts?: VertexResponsePart[] };
        finishReason?: string;
    }>;
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
    };
    error?: { code?: number; message?: string; status?: string };
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function extractInvoiceWithVertex(
    config: VertexExtractionConfig,
    pdf: Uint8Array,
): Promise<VertexExtractionOutput> {
    if (pdf.byteLength === 0 || pdf.byteLength > MAX_INLINE_PDF_BYTES) {
        throw new VertexExtractionError('The PDF is too large to read with AI.', 'provider_error', 413);
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.mode === 'service-account') {
        headers.Authorization = `Bearer ${await serviceAccountToken(config.serviceAccount!)}`;
    }
    const body = {
        systemInstruction: { parts: [{ text: EXTRACTION_SYSTEM_INSTRUCTION }] },
        contents: [{
            role: 'user',
            parts: [
                { inlineData: { mimeType: 'application/pdf', data: toBase64(pdf) } },
                { text: EXTRACTION_USER_PROMPT },
            ],
        }],
        generationConfig: {
            temperature: 0,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            responseSchema: EXTRACTION_RESPONSE_SCHEMA,
        },
    };

    let response: Response;
    try {
        response = await fetch(vertexEndpoint(config), {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new VertexExtractionError('The AI provider timed out.', 'timeout', 504);
        }
        throw new VertexExtractionError('The AI provider could not be reached.', 'provider_error', 502);
    }

    const payload = await readJson(response);
    if (!response.ok) {
        const message = payload?.error?.message?.slice(0, 300) ?? `HTTP ${response.status}`;
        if (response.status === 401 || response.status === 403) {
            throw new VertexExtractionError('The AI provider rejected the credential.', 'unauthorized', 502);
        }
        if (response.status === 429) {
            throw new VertexExtractionError('The AI provider is rate limiting requests.', 'rate_limited', 429);
        }
        if (response.status === 413) {
            throw new VertexExtractionError('The document is too large for the AI provider.', 'provider_error', 413);
        }
        throw new VertexExtractionError(`The AI provider failed: ${message}`, 'provider_error', 502);
    }

    const text = extractResponseText(payload);
    if (!text) {
        throw new VertexExtractionError('The AI provider returned no text.', 'empty_response', 502);
    }
    const invoice = parseInvoiceJson(text);
    return {
        invoice,
        model: config.model,
        usage: readUsage(payload),
    };
}

function extractResponseText(payload: VertexGenerateContentResponse | null): string | null {
    const parts = payload?.candidates?.[0]?.content?.parts ?? [];
    const part = parts.find((candidate) => candidate.thought !== true && typeof candidate.text === 'string');
    return part?.text?.trim() ?? null;
}

function parseInvoiceJson(text: string): ExtractedInvoice {
    const withoutFences = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed: unknown;
    try {
        parsed = JSON.parse(withoutFences);
    } catch {
        throw new VertexExtractionError('The AI provider returned invalid JSON.', 'invalid_output', 502);
    }
    if (!isExtractedInvoice(parsed)) {
        throw new VertexExtractionError('The AI provider returned an unexpected document shape.', 'invalid_output', 502);
    }
    return parsed;
}

function readUsage(payload: VertexGenerateContentResponse | null): VertexExtractionUsage | null {
    const usage = payload?.usageMetadata;
    if (!usage) return null;
    return {
        promptTokenCount: usage.promptTokenCount ?? 0,
        candidatesTokenCount: usage.candidatesTokenCount ?? 0,
        thoughtsTokenCount: usage.thoughtsTokenCount ?? 0,
        totalTokenCount: usage.totalTokenCount ?? 0,
    };
}

async function readJson(response: Response): Promise<VertexGenerateContentResponse | null> {
    try {
        return await response.json() as VertexGenerateContentResponse;
    } catch {
        return null;
    }
}

async function serviceAccountToken(serviceAccount: ServiceAccount): Promise<string> {
    const cached = tokenCache.get(serviceAccount.clientEmail);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const now = Math.floor(Date.now() / 1000);
    const key = await importPKCS8(serviceAccount.privateKey, 'RS256');
    const assertion = await new SignJWT({ scope: OAUTH_SCOPE })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(serviceAccount.privateKeyId ? { kid: serviceAccount.privateKeyId } : {}) })
        .setIssuer(serviceAccount.clientEmail)
        .setAudience(OAUTH_TOKEN_URL)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(key);

    const response = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new VertexExtractionError('The AI provider rejected the service account.', 'unauthorized', 502);
    }
    const payload = await response.json() as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
        throw new VertexExtractionError('The AI provider returned no access token.', 'unauthorized', 502);
    }
    tokenCache.set(serviceAccount.clientEmail, {
        token: payload.access_token,
        expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    });
    return payload.access_token;
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}
