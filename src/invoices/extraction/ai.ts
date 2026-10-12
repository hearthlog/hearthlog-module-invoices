import { AccessSessionExpiredError, fetchAccessProtected } from '@hearthlog/sdk/runtime';
import { requireActiveContext } from '@hearthlog/sdk/runtime';
import { isExtractedInvoice } from './schema.js';
import type { ExtractedInvoice, ExtractionWarning } from './types.js';

/**
 * Client for the same-origin AI extraction route. The Worker owns the provider
 * credential; this module only maps transport results to the shared extraction
 * shape and never falls back silently — callers surface every failure so the
 * user can fall back to manual entry.
 */

export interface AiUsage {
    promptTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount: number;
    totalTokenCount: number;
}

export interface AiExtraction {
    invoice: ExtractedInvoice;
    provider: string;
    model: string;
    warnings: ExtractionWarning[];
    usage: AiUsage | null;
}

export type AiReadOutcome =
    | ({ kind: 'found' } & AiExtraction)
    | { kind: 'offline' }
    | { kind: 'unavailable'; message: string }
    | { kind: 'failed'; message: string };

export async function readInvoiceWithAi(file: File): Promise<AiReadOutcome> {
    // Some non-browser environments expose `navigator` without `onLine`.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return { kind: 'offline' };
    }
    let logId: string;
    try {
        logId = (await requireActiveContext()).logId;
    } catch {
        return { kind: 'failed', message: 'Select a log before reading with AI.' };
    }

    let response: Response;
    try {
        response = await fetchAccessProtected(`/api/received-invoice-extraction/v1/logs/${logId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/pdf' },
            body: file,
        });
    } catch (error) {
        if (error instanceof AccessSessionExpiredError) {
            return { kind: 'failed', message: 'Your session expired. Sign in again to read with AI.' };
        }
        return { kind: 'failed', message: 'The AI service could not be reached.' };
    }

    if (response.status === 503) {
        return { kind: 'unavailable', message: 'AI reading is not configured for this site.' };
    }
    if (response.status === 429) {
        return { kind: 'failed', message: 'The AI service is busy. Try again in a moment.' };
    }
    if (response.status === 413) {
        return { kind: 'failed', message: 'This PDF is too large to read with AI (limit 10 MiB).' };
    }
    if (!response.ok) {
        return { kind: 'failed', message: 'The document could not be read with AI.' };
    }

    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        return { kind: 'failed', message: 'The AI service returned an unexpected response.' };
    }
    const parsed = parsePayload(payload);
    if (!parsed) {
        return { kind: 'failed', message: 'The AI service returned an unexpected result.' };
    }
    return { kind: 'found', ...parsed };
}

function parsePayload(payload: unknown): AiExtraction | null {
    if (!payload || typeof payload !== 'object') return null;
    const record = payload as Record<string, unknown>;
    if (!isExtractedInvoice(record.extraction)) return null;
    return {
        invoice: record.extraction,
        provider: typeof record.provider === 'string' ? record.provider : 'vertex',
        model: typeof record.model === 'string' ? record.model : '',
        warnings: parseWarnings(record.warnings),
        usage: parseUsage(record.usage),
    };
}

function parseWarnings(value: unknown): ExtractionWarning[] {
    if (!Array.isArray(value)) return [];
    const warnings: ExtractionWarning[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        if (typeof record.message !== 'string') continue;
        warnings.push({
            code: (typeof record.code === 'string' ? record.code : 'missing-field') as ExtractionWarning['code'],
            message: record.message,
            ...(typeof record.field === 'string' && record.field ? { field: record.field as ExtractionWarning['field'] } : {}),
        });
    }
    return warnings;
}

function parseUsage(value: unknown): AiUsage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const read = (key: string): number => (typeof record[key] === 'number' ? record[key] as number : 0);
    return {
        promptTokenCount: read('promptTokenCount'),
        candidatesTokenCount: read('candidatesTokenCount'),
        thoughtsTokenCount: read('thoughtsTokenCount'),
        totalTokenCount: read('totalTokenCount'),
    };
}
