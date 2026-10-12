/**
 * Decimal helpers for extracted invoice values.
 *
 * Values travel as strings and are only converted to numbers for validation
 * arithmetic, rounded half-up at cents. Persistence converts through the same
 * helpers so a stored value is never the result of an unrounded computation.
 */

const SPACE_PATTERN = /[\s\u00a0\u202f]/g;
const DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Accepts both canonical (`"1234.56"`) and Czech-shaped (`"1 234,56"`) input.
 * When both separators appear, the last one is treated as the decimal mark.
 */
function normalizeDecimalText(raw: string): string {
    let value = raw.replace(SPACE_PATTERN, '');
    const comma = value.lastIndexOf(',');
    const dot = value.lastIndexOf('.');
    if (comma !== -1 && dot !== -1) {
        value = comma > dot
            ? value.replace(/\./g, '').replace(',', '.')
            : value.replace(/,/g, '');
    } else if (comma !== -1) {
        value = value.replace(',', '.');
    }
    return value;
}

/** Parses a decimal string, returning `null` for empty or malformed input. */
export function parseDecimalString(value: string | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const normalized = normalizeDecimalText(value);
    if (!DECIMAL_PATTERN.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Rounds half away from zero at the given number of decimals. */
export function roundHalfUp(value: number, decimals = 2): number {
    if (!Number.isFinite(value)) return NaN;
    const factor = 10 ** decimals;
    const scaled = value * factor;
    const nudged = scaled + Math.sign(scaled) * Number.EPSILON * Math.abs(scaled);
    const rounded = scaled >= 0 ? Math.floor(nudged + 0.5) : Math.ceil(nudged - 0.5);
    return rounded / factor;
}

/** Formats a number as a canonical decimal string with the given scale. */
export function decimalToString(value: number, decimals = 2): string {
    if (!Number.isFinite(value)) return '';
    return value.toFixed(decimals);
}

/**
 * Canonicalizes an extracted decimal string at the given scale (money uses 2).
 * Unparseable input is returned trimmed so the original text is never lost.
 */
export function normalizeDecimalString(value: string | null | undefined, decimals = 2): string {
    const parsed = parseDecimalString(value);
    if (parsed === null) return (value ?? '').trim();
    return roundHalfUp(parsed, decimals).toFixed(decimals);
}

export interface LineAmounts {
    net: number;
    vat: number;
    gross: number;
}

/**
 * Computes line amounts with the invoice-generation contract's rounding:
 * `net = round(quantity × unitPrice)`, `vat = round(net × rate / 100)`.
 *
 * When the source declares its own line amounts (`netAmount`, `vatAmount`),
 * those are authoritative: suppliers round differently (for example Alza
 * truncates 45.486 to 45.48), and recomputing would flag every legitimate
 * invoice as a mismatch.
 */
export function lineAmounts(
    item: {
        quantity: string;
        unitPrice: string;
        vatRate: string;
        netAmount?: string;
        vatAmount?: string;
    },
): LineAmounts | null {
    const declaredNet = parseDecimalString(item.netAmount);
    const declaredVat = parseDecimalString(item.vatAmount);
    const quantity = parseDecimalString(item.quantity);
    const unitPrice = parseDecimalString(item.unitPrice);
    const vatRate = parseDecimalString(item.vatRate);
    if (declaredNet === null && (quantity === null || unitPrice === null)) return null;
    const net = declaredNet ?? roundHalfUp(quantity! * unitPrice!, 2);
    let vat: number;
    if (declaredVat !== null) vat = declaredVat;
    else if (vatRate !== null) vat = roundHalfUp((net * vatRate) / 100, 2);
    else return null;
    return { net, vat, gross: roundHalfUp(net + vat, 2) };
}
