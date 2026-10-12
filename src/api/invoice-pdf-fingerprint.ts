/**
 * Deterministic invoice PDF fingerprints, shared by the browser client and the
 * Hearthlog Worker cache.
 *
 * The cache must never serve a document that does not match the invoice data
 * currently being requested. Both sides therefore canonicalize the exact
 * renderer request and hash it with SHA-256. Canonicalization sorts object
 * keys, preserves array order (line items), drops audit/sync/overdue fields,
 * and collapses the workflow status into the two headings the renderer knows:
 * `draft` and `issued` (sent, paid and overdue all render as issued).
 *
 * This module must stay dependency-free: the Worker bundles it directly and
 * has no browser or SvelteKit imports.
 */

/** Bump when templates, calculations, fonts or embedded documents change. */
export const INVOICE_PDF_RENDERER_REVISION = 3;

/** Bump when the canonicalization or stored cache shape changes. */
export const INVOICE_PDF_CACHE_SCHEMA_VERSION = 1;

/** Canonical JSON for one request; also used for cheap stale checks. */
export function canonicalInvoicePdfRequestKey(request: unknown): string {
    return JSON.stringify({
        schema: INVOICE_PDF_CACHE_SCHEMA_VERSION,
        rendererRevision: INVOICE_PDF_RENDERER_REVISION,
        request: canonicalize(request, ""),
    });
}

/** SHA-256 hex digest of the canonical request. */
export async function computeInvoicePdfFingerprint(
    request: unknown,
): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalInvoicePdfRequestKey(request)),
    );
    return hex(new Uint8Array(digest));
}

function canonicalize(value: unknown, path: string): unknown {
    if (Array.isArray(value)) {
        return value.map((entry, index) =>
            canonicalize(entry, `${path}[${index}]`),
        );
    }
    if (value !== null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const normalized: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) {
            const child = source[key];
            if (child === undefined) continue;
            const childPath = path ? `${path}.${key}` : key;
            // The renderer's PDF does not change with the calculated overdue
            // badge, so it must never invalidate a saved document.
            if (childPath === "invoice.isOverdue") continue;
            // Only the draft/issued heading is rendered; sent, paid and
            // overdue share the issued identity.
            if (childPath === "invoice.status") {
                normalized[key] = normalizeStatus(child);
                continue;
            }
            normalized[key] = canonicalize(child, childPath);
        }
        return normalized;
    }
    return value;
}

function normalizeStatus(value: unknown): "draft" | "issued" {
    return value === "draft" ? "draft" : "issued";
}

function hex(bytes: Uint8Array): string {
    let result = "";
    for (const byte of bytes) {
        result += byte.toString(16).padStart(2, "0");
    }
    return result;
}
