import {
    authorizeStorRequest,
    LedgerAdminConfigurationError,
    type LedgerAdminIdentity,
    type StorAuthEnv,
} from "@hearthlog/sdk/server";

/**
 * Same-origin gateway for the external invoice document renderer.
 *
 * The renderer requires a bearer credential and does not answer browser CORS
 * preflights, so the browser never calls it directly. The Worker attaches the
 * credential and forwards the request body unchanged.
 */

const INVOICE_RENDERER_PREFIX = "/api/invoice-generation";
const ALLOWED_PATHS = new Set([
    `${INVOICE_RENDERER_PREFIX}/pdf`,
    `${INVOICE_RENDERER_PREFIX}/isdoc`,
]);
/** The renderer accepts a single invoice snapshot; never buffer more than this. */
const MAX_REQUEST_BYTES = 1024 * 1024;

export type InvoiceRendererEnv = StorAuthEnv & Pick<Env, "INVOICE_RENDERER_TOKEN" | "INVOICE_RENDERER_ORIGIN">;
type StorAuthorizer = (
    request: Request,
    env: StorAuthEnv,
) => Promise<LedgerAdminIdentity>;

export async function proxyInvoiceRendererRequest(
    request: Request,
    env: InvoiceRendererEnv,
    authorize: StorAuthorizer = authorizeStorRequest,
): Promise<Response> {
    const publicUrl = new URL(request.url);
    if (
        request.method !== "POST" ||
        !ALLOWED_PATHS.has(publicUrl.pathname)
    ) {
        return rendererError(
            404,
            "invoice_renderer_route_not_found",
            "Invoice renderer route not found",
        );
    }
    if (!env.INVOICE_RENDERER_TOKEN || !env.INVOICE_RENDERER_ORIGIN) {
        return rendererError(
            503,
            "invoice_renderer_unconfigured",
            "Invoice renderer is not configured",
        );
    }
    if (!isJsonContentType(request.headers.get("Content-Type"))) {
        return rendererError(
            415,
            "unsupported_media_type",
            "Invoice renderer requests must be application/json",
        );
    }

    const browserOrigin = request.headers.get("Origin");
    if (browserOrigin !== null && browserOrigin !== publicUrl.origin) {
        return rendererError(
            403,
            "origin_not_allowed",
            "Cross-origin invoice renderer requests are not allowed",
        );
    }
    try {
        await authorize(request, env);
    } catch (error) {
        if (error instanceof LedgerAdminConfigurationError) {
            return rendererError(
                503,
                "invoice_renderer_unconfigured",
                "Invoice renderer is not configured",
            );
        }
        return rendererError(
            403,
            "invoice_renderer_forbidden",
            "Hearthlog access is required",
        );
    }

    const declaredLength = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
        return tooLargeError();
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_REQUEST_BYTES) {
        return tooLargeError();
    }

    let response: Response;
    try {
        // Build the outbound request explicitly instead of cloning the
        // browser request: Access cookies and headers must not leave this
        // origin, and the renderer owns the Authentication header.
        response = await fetch(
            `${env.INVOICE_RENDERER_ORIGIN.replace(/\/$/, "")}${publicUrl.pathname}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/pdf, application/xml, application/problem+json",
                    Authorization: `Bearer ${env.INVOICE_RENDERER_TOKEN}`,
                },
                body,
            },
        );
    } catch {
        return rendererError(
            502,
            "invoice_renderer_unreachable",
            "The invoice renderer could not be reached",
        );
    }
    if (response.status === 401) {
        // The public request is authenticated by Access; a 401 here means the
        // renderer rejected the server credential, so do not surface it as an
        // expired browser session.
        return rendererError(
            502,
            "invoice_renderer_credential_rejected",
            "The invoice renderer rejected the server credential",
        );
    }
    return noStore(response);
}

function isJsonContentType(value: string | null): boolean {
    if (!value) return false;
    return value.split(";")[0]!.trim().toLowerCase() === "application/json";
}

function tooLargeError(): Response {
    return rendererError(
        413,
        "invoice_snapshot_too_large",
        "The invoice snapshot is too large to render",
    );
}

function rendererError(
    status: number,
    code: string,
    error: string,
): Response {
    return noStore(Response.json({ error, code }, { status }));
}

function noStore(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
    });
}
