import type { Invoice } from "../data/invoices.js";

/** The amount the customer pays, including line-item VAT. */
export function invoiceTotalPayable(invoice: Pick<Invoice, "amount" | "items">): number {
    if (!invoice.items) return invoice.amount;

    try {
        const items: unknown = JSON.parse(invoice.items);
        if (!Array.isArray(items) || items.length === 0) return invoice.amount;

        let total = 0;
        for (const item of items) {
            if (!item || typeof item !== "object") return invoice.amount;
            const { quantity, unitPrice, vatRate } = item as Record<string, unknown>;
            const line = Number(quantity) * Number(unitPrice);
            const rate = Number(vatRate ?? 0);
            if (!Number.isFinite(line) || !Number.isFinite(rate)) return invoice.amount;
            total += line * (1 + rate / 100);
        }
        return Math.round((total + Number.EPSILON) * 100) / 100;
    } catch {
        return invoice.amount;
    }
}
