/**
 * On-demand ISDOC export for both invoice directions.
 *
 * A stored original (imported issued invoices, received invoices) is always
 * preferred. Otherwise the ISDOC embedded in the invoice's PDF is read on this
 * device: an imported issued invoice first tries its stored original, then the
 * PDF rendered from the current invoice data. The exported XML therefore
 * matches the document the user is looking at instead of a second renderer
 * round trip, and needs no server-side cache of its own.
 */

import { resolveInvoicePdf } from "../api/invoice-pdf-cache.js";
import type { BuildInvoiceRequestOptions } from "../api/invoice-renderer.js";
import type { Invoice } from "../data/invoices.js";
import { readIsdocAttachmentFromPdf } from "./extraction/pdf-extract.js";
import { getIssuedIsdoc, getIssuedPdf } from "./issued-file-store.js";

export interface IsdocExport {
    blob: Blob;
    fileName: string;
}

/** The ISDOC of an issued invoice, stored or taken from its PDF. */
export async function exportIssuedIsdoc(
    invoice: Invoice,
    options: BuildInvoiceRequestOptions,
): Promise<IsdocExport> {
    if (invoice.isdoc_file_id) {
        return {
            blob: await getIssuedIsdoc(invoice),
            fileName: invoice.isdoc_file_name || "invoice.isdoc",
        };
    }
    // An imported original can carry the ISDOC even when no copy was stored
    // with the record; it also works offline without a fresh render.
    if (invoice.file_id) {
        try {
            const fromOriginal = await isdocFromPdf(await getIssuedPdf(invoice));
            if (fromOriginal) return fromOriginal;
        } catch {
            // A missing local or server copy falls through to the render.
        }
    }
    const rendered = await resolveInvoicePdf(invoice, options);
    const exported = await isdocFromPdf(rendered.blob);
    if (!exported) {
        throw new Error(
            "The invoice PDF does not include an electronic invoice (ISDOC). Regenerate it after completing the invoice details.",
        );
    }
    return exported;
}

/** Reads the ISDOC attachment out of a PDF, or null when it carries none. */
export async function isdocFromPdf(blob: Blob): Promise<IsdocExport | null> {
    const outcome = await readIsdocAttachmentFromPdf(blob);
    if (outcome.kind === "unreadable") throw new Error(outcome.message);
    if (outcome.kind === "none") return null;
    return {
        blob: new Blob([outcome.xml], {
            type: "application/xml;charset=utf-8",
        }),
        fileName: outcome.name || "invoice.isdoc",
    };
}
