import { normalizeDecimalString, parseDecimalString } from './decimal.js';
import type { ExtractionResult, ExtractedInvoice, ExtractedItem } from './types.js';

/**
 * Form-facing merge rules for extraction results.
 *
 * Extraction assists the user; it never silently overwrites a value the user
 * edited by hand. The component tracks the values applied by the previous run
 * (`lastApplied`) so a re-run can fill untouched fields while preserving edits.
 */

/** The visible drawer inputs that extraction may fill. */
export interface FormValues {
    supplierName: string;
    invoiceNumber: string;
    amount: string;
    issueDate: string;
    dueDate: string;
}

export interface MergeResolutions {
    values: FormValues;
    /** Fields with user edits that the incoming extraction did not override. */
    preserved: Array<keyof FormValues>;
}

const FORM_KEYS: Array<keyof FormValues> = [
    'supplierName', 'invoiceNumber', 'amount', 'issueDate', 'dueDate',
];

export function formValuesFrom(invoice: ExtractedInvoice): FormValues {
    return {
        supplierName: invoice.supplierName,
        invoiceNumber: invoice.invoiceNumber,
        // Sources may carry four-decimal money (for example ISDOC's
        // `216.6000`); the form and its parser accept two.
        amount: normalizeDecimalString(invoice.amount),
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
    };
}

/**
 * Applies incoming values to empty or untouched fields. A field is untouched
 * when it is empty or still equals the value the previous extraction applied.
 */
export function mergeExtraction(
    current: FormValues,
    lastApplied: FormValues | null,
    incoming: FormValues,
): MergeResolutions {
    const values = { ...current };
    const preserved: Array<keyof FormValues> = [];
    for (const key of FORM_KEYS) {
        const proposed = incoming[key];
        if (!proposed) continue;
        const untouched = !current[key] || current[key] === lastApplied?.[key];
        if (untouched) {
            values[key] = proposed;
        } else if (current[key] !== proposed) {
            preserved.push(key);
        }
    }
    return { values, preserved };
}

export interface StoredInvoiceItem {
    description: string;
    quantity: number;
    unitPrice: number;
    vatRate: number;
}

/**
 * Converts extracted decimal-string items to the stored shape used by the
 * generated invoices (`quantity`, `unitPrice`, `vatRate` as numbers).
 * Unparseable lines are dropped rather than stored as zeroes.
 */
export function serializeItems(items: ExtractedItem[]): string {
    const parsed: StoredInvoiceItem[] = [];
    for (const item of items) {
        const quantity = parseDecimalString(item.quantity);
        const unitPrice = parseDecimalString(item.unitPrice);
        const vatRate = parseDecimalString(item.vatRate);
        if (quantity === null || unitPrice === null || vatRate === null) continue;
        parsed.push({ description: item.description, quantity, unitPrice, vatRate });
    }
    return JSON.stringify(parsed);
}

/**
 * Provenance stored on the invoice: reader metadata, warnings, and when the
 * extraction was applied. Raw document contents are never part of it.
 */
export function serializeExtractionMetadata(result: ExtractionResult): string {
    return JSON.stringify({
        source: result.source,
        ...result.metadata,
        warnings: result.warnings.map((warning) => ({
            code: warning.code,
            field: warning.field ?? '',
            message: warning.message,
        })),
        extractedAt: new Date().toISOString(),
    });
}
