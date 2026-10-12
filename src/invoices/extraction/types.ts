import type { ExtractedInvoicePayload, ExtractedItemPayload } from "./schema.js";

/**
 * Domain model for received-invoice extraction.
 *
 * Both readers — the deterministic ISDOC parser and (in the LLM phase) the
 * provider adapter — produce an `ExtractedInvoice`, and both feed the same
 * merge/review path before anything is saved.
 */
export type ExtractedInvoice = ExtractedInvoicePayload;
export type ExtractedItem = ExtractedItemPayload;

export type ExtractionSource = "isdoc" | "ai" | "manual";

export type ExtractionWarningCode =
    /** The PDF could not be read (encrypted, corrupt, unsupported layout). */
    | "unreadable-pdf"
    /** An attachment looked like ISDOC but its XML could not be parsed. */
    | "invalid-isdoc"
    /** A field that the document usually carries is absent. */
    | "missing-field"
    /** Declared totals disagree with line arithmetic. */
    | "totals-mismatch"
    /** The document states nothing left to pay; the invoice total was used. */
    | "zero-payable"
    /** Negative or otherwise credit-note-shaped total. */
    | "negative-amount"
    /** Non-CZK currency that the current UI does not treat specially. */
    | "foreign-currency";

export interface ExtractionWarning {
    code: ExtractionWarningCode;
    message: string;
    field?: keyof ExtractedInvoice;
}

export type ExtractionMetadataValue = string | number | boolean | null;
export type ExtractionMetadata = Record<string, ExtractionMetadataValue>;

export interface ExtractionResult {
    source: ExtractionSource;
    invoice: ExtractedInvoice;
    warnings: ExtractionWarning[];
    /** Reader-specific details: ISDOC version and attachment name, LLM provider/model/usage. */
    metadata: ExtractionMetadata;
}

export function emptyExtractedInvoice(): ExtractedInvoice {
    return {
        supplierName: "",
        supplierIco: "",
        supplierDic: "",
        supplierStreet: "",
        supplierCity: "",
        customerName: "",
        customerIco: "",
        customerDic: "",
        customerStreet: "",
        customerCity: "",
        invoiceNumber: "",
        amount: "",
        subtotal: "",
        vatTotal: "",
        currency: "CZK",
        vatApplicable: null,
        issueDate: "",
        dueDate: "",
        taxPointDate: "",
        bankAccount: "",
        variableSymbol: "",
        items: [],
    };
}
