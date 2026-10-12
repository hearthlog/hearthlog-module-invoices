/**
 * The number after an invoice number: its last run of digits counts up and
 * keeps its width ("2026-034" → "2026-035", "INV9" → "INV10"). A number
 * without digits gets "-2" so the suggestion never repeats the last one.
 */
export function nextInvoiceNumber(last: string): string {
    const trimmed = last.trim();
    if (!trimmed) return '';
    const match = trimmed.match(/^(.*?)(\d+)(\D*)$/);
    if (!match) return `${trimmed}-2`;
    const [, prefix, digits, suffix] = match;
    const next = String(BigInt(digits) + 1n).padStart(digits.length, '0');
    return `${prefix}${next}${suffix}`;
}
