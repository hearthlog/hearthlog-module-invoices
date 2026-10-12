/**
 * Whether an issued invoice can offer its electronic invoice (ISDOC), and the
 * wording used when it cannot. The detail drawer disables the actions and the
 * PDF pane names the same missing facts, so both read them from here.
 */

import {
    buildInvoiceGenerationRequest,
    isdocDocumentGaps,
    type BuildInvoiceRequestOptions,
} from "../api/invoice-renderer.js";
import type { Invoice } from "../data/invoices.js";

/** Join missing ISDOC facts, e.g. "the document UUID and payment instructions". */
export function formatIsdocGaps(gaps: readonly string[]): string {
    try {
        return new Intl.ListFormat("en", {
            style: "long",
            type: "conjunction",
        }).format(gaps);
    } catch {
        return gaps.join(", ");
    }
}

export type IssuedIsdocAvailability =
    | { kind: "stored" }
    | { kind: "export" }
    | { kind: "unavailable"; gaps: string[]; message: string };

/**
 * A stored original can always be offered. A created document is exported
 * from its PDF only when the ISDOC profile is complete; otherwise the caller
 * shows the gap list or the reason the snapshot could not be built.
 */
export function issuedIsdocAvailability(
    invoice: Invoice,
    options: BuildInvoiceRequestOptions,
): IssuedIsdocAvailability {
    if (invoice.isdoc_file_id) return { kind: "stored" };
    try {
        const gaps = isdocDocumentGaps(
            buildInvoiceGenerationRequest(invoice, options).invoice,
        );
        if (gaps.length) return { kind: "unavailable", gaps, message: "" };
        return { kind: "export" };
    } catch (error) {
        return {
            kind: "unavailable",
            gaps: [],
            message:
                error instanceof Error
                    ? error.message
                    : "The electronic invoice is unavailable.",
        };
    }
}
