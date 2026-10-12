import {
    authorizeStorRequest,
    LedgerAdminAuthorizationError,
    LedgerAdminConfigurationError,
    type LedgerAdminIdentity,
} from "@hearthlog/sdk/server";
import { LedgerScopeError, verifyLogAppId } from "@hearthlog/sdk/server";
import {
    extractInvoiceWithVertex,
    vertexConfigFromEnv,
    VertexExtractionError,
} from "./vertex.js";
import { missingFieldWarnings, normalizeExtractedMoney, totalWarnings } from "../invoices/extraction/validate.js";

/**
 * Same-origin gateway for AI invoice reading. The browser sends one PDF; the
 * Worker verifies the Access session and Ledger log, calls Vertex AI with its
 * server-side credential, validates the structured output and returns the
 * shared extraction shape for the review UI.
 */

const PREFIX = "/api/received-invoice-extraction/v1";
const MAX_BYTES = 10 * 1024 * 1024;
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ROUTE = new RegExp(`^${PREFIX}/logs/(${UUID})$`);

export type ReceivedInvoiceExtractionEnv = Pick<Env,
    "CF_ACCESS_APP_AUD" | "CF_ACCESS_TEAM_DOMAIN" | "LEDGER" | "LEDGER_AUTH_TOKEN" |
    "STOR_AUTHORIZED_EMAILS" | "INVOICE_EXTRACTION_API_KEY" | "INVOICE_EXTRACTION_SERVICE_ACCOUNT" |
    "INVOICE_EXTRACTION_MODEL" | "INVOICE_EXTRACTION_LOCATION"
>;
type Authorizer = (request: Request, env: ReceivedInvoiceExtractionEnv) => Promise<LedgerAdminIdentity>;

export async function handleReceivedInvoiceExtractionRequest(
    request: Request,
    env: ReceivedInvoiceExtractionEnv,
    authorize: Authorizer = authorizeStorRequest,
): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(ROUTE);
    if (!match || request.method !== "POST") {
        return errorResponse(404, "extraction_route_not_found", "AI invoice extraction route not found");
    }
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) {
        return errorResponse(403, "origin_not_allowed", "Cross-origin extraction requests are not allowed");
    }
    try {
        await authorize(request, env);
    } catch (error) {
        return errorResponse(
            error instanceof LedgerAdminConfigurationError ? 503 : 403,
            error instanceof LedgerAdminConfigurationError ? "extraction_unconfigured" : "extraction_forbidden",
            error instanceof LedgerAdminAuthorizationError ? "Hearthlog access is required" : "AI invoice extraction is unavailable",
        );
    }
    try {
        await verifyLogAppId(match[1], env);
    } catch (error) {
        return error instanceof LedgerScopeError
            ? errorResponse(error.status, error.code, error.message)
            : errorResponse(503, "ledger_verification_failed", "The selected log could not be verified");
    }
    const config = vertexConfigFromEnv(env);
    if (!config) {
        return errorResponse(503, "extraction_unconfigured", "AI invoice reading is not configured");
    }

    if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/pdf") {
        return errorResponse(415, "unsupported_file_type", "Upload a PDF file");
    }
    const declaredLength = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
        return tooLarge();
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) {
        return tooLarge();
    }
    if (String.fromCharCode(...body.subarray(0, 5)) !== "%PDF-") {
        return errorResponse(415, "invalid_pdf", "The file is not a PDF");
    }

    try {
        const output = await extractInvoiceWithVertex(config, body);
        const normalized = normalizeExtractedMoney(output.invoice);
        const warnings = [
            ...normalized.warnings,
            ...missingFieldWarnings(normalized.invoice),
            ...totalWarnings(normalized.invoice),
        ];
        return secureResponse(JSON.stringify({
            extraction: normalized.invoice,
            provider: "vertex",
            model: output.model,
            warnings,
            usage: output.usage,
        }), {
            headers: { "Content-Type": "application/json; charset=utf-8" },
        });
    } catch (error) {
        if (error instanceof VertexExtractionError) {
            switch (error.code) {
                case "unauthorized":
                    return errorResponse(502, "extraction_credential_rejected", "The AI provider rejected the server credential");
                case "rate_limited":
                    return errorResponse(429, "extraction_rate_limited", "The AI provider is busy; try again shortly");
                case "timeout":
                    return errorResponse(504, "extraction_timeout", "The AI provider timed out");
                case "invalid_output":
                case "empty_response":
                    return errorResponse(502, "extraction_invalid_output", "The AI provider returned an unreadable document");
                default:
                    return errorResponse(error.status === 413 ? 413 : 502, "extraction_provider_failed", "The document could not be read");
            }
        }
        throw error;
    }
}

function tooLarge(): Response {
    return errorResponse(413, "file_too_large", "PDFs for AI reading must be 10 MiB or smaller");
}

function errorResponse(status: number, code: string, message: string): Response {
    return secureResponse(JSON.stringify({ code, error: message }), {
        status, headers: { "Content-Type": "application/json; charset=utf-8" },
    });
}

function secureResponse(body: BodyInit | null, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(body, { ...init, headers });
}
