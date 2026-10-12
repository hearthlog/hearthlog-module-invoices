import { decimalToString, lineAmounts, normalizeDecimalString, parseDecimalString, roundHalfUp, type LineAmounts } from './decimal.js';
import type { ExtractedInvoice, ExtractionWarning } from './types.js';

/** Half a cent: the largest difference that is not a real arithmetic error. */
const CENT_TOLERANCE = 0.005;

/** Fields a complete received invoice needs; empty values become warnings. */
export const REQUIRED_EXTRACTION_FIELDS: Array<[keyof ExtractedInvoice, string]> = [
    ['supplierName', 'the supplier name'],
    ['invoiceNumber', 'the invoice number'],
    ['amount', 'the payable amount'],
    ['issueDate', 'the issue date'],
    ['dueDate', 'the due date'],
];

/** Warns about required fields the document did not provide. */
export function missingFieldWarnings(invoice: ExtractedInvoice): ExtractionWarning[] {
    const warnings: ExtractionWarning[] = [];
    for (const [field, label] of REQUIRED_EXTRACTION_FIELDS) {
        if (!String(invoice[field]).trim()) {
            warnings.push({ code: 'missing-field', field, message: `The document is missing ${label}.` });
        }
    }
    return warnings;
}

/**
 * Shared money normalization for provider output: canonical two-decimal
 * totals, and the "nothing left to pay" substitution when a document reports
 * a zero payable amount but non-zero line totals (usually already settled).
 */
export function normalizeExtractedMoney(
    invoice: ExtractedInvoice,
): { invoice: ExtractedInvoice; warnings: ExtractionWarning[] } {
    const subtotal = parseDecimalString(invoice.subtotal);
    const vatTotal = parseDecimalString(invoice.vatTotal);
    const total = subtotal !== null && vatTotal !== null ? roundHalfUp(subtotal + vatTotal, 2) : null;
    const payable = parseDecimalString(invoice.amount);
    const zeroPayable = payable === 0 && total !== null && total > 0;
    const amount = zeroPayable && total !== null ? decimalToString(total) : normalizeDecimalString(invoice.amount);
    const normalized: ExtractedInvoice = {
        ...invoice,
        amount,
        subtotal: normalizeDecimalString(invoice.subtotal),
        vatTotal: normalizeDecimalString(invoice.vatTotal),
    };
    const warnings: ExtractionWarning[] = zeroPayable ? [{
        code: 'zero-payable',
        field: 'amount',
        message: `The document states nothing left to pay; the invoice total ${amount} ${normalized.currency} is used instead.`,
    }] : [];
    return { invoice: normalized, warnings };
}

/**
 * Compares declared totals with the sum of line amounts.
 *
 * The contract's calculation is: line net = `round(quantity × unitPrice)`,
 * line VAT = `round(net × rate / 100)`, totals are sums of the rounded lines.
 * Declared values are never rewritten; a mismatch only produces a warning so
 * the user can decide whether to trust the lines or the header.
 */
export function totalWarnings(invoice: ExtractedInvoice): ExtractionWarning[] {
    const warnings: ExtractionWarning[] = [];
    const lines = invoice.items.map((item) => lineAmounts(item));
    if (lines.length > 0 && lines.every((line): line is LineAmounts => line !== null)) {
        const subtotal = roundHalfUp(lines.reduce((sum, line) => sum + line.net, 0), 2);
        const vatTotal = roundHalfUp(lines.reduce((sum, line) => sum + line.vat, 0), 2);
        const amount = roundHalfUp(subtotal + vatTotal, 2);
        const comparisons: Array<[keyof ExtractedInvoice, string, number]> = [
            ['subtotal', invoice.subtotal, subtotal],
            ['vatTotal', invoice.vatTotal, vatTotal],
            ['amount', invoice.amount, amount],
        ];
        for (const [field, declaredRaw, computed] of comparisons) {
            const declared = parseDecimalString(declaredRaw);
            if (declared === null) continue;
            if (Math.abs(declared - computed) > CENT_TOLERANCE) {
                warnings.push({
                    code: 'totals-mismatch',
                    field,
                    message: `The document states ${format(declared)} but its lines add up to ${format(computed)}.`,
                });
            }
        }
    }

    const amount = parseDecimalString(invoice.amount);
    if (amount !== null && amount < 0) {
        warnings.push({
            code: 'negative-amount',
            field: 'amount',
            message: 'The document has a negative total. Credit notes are not modeled yet, so check the values carefully.',
        });
    }
    return warnings;
}

function format(value: number): string {
    return value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
