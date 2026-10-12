/**
 * Maps an extracted supplier document onto the issued-invoice form.
 *
 * A document that was issued outside the app has the roles inverted: its
 * supplier is the importing company and its customer is the counterparty.
 * These helpers turn the shared extraction result into form values without
 * overwriting edits the user already made to a previous extraction.
 */

import { DEFAULT_VAT_RATE } from "../config/invoice-defaults.js";
import { invoicePaymentTermDays, type InvoicePartySource } from "./document.js";
import { parseDecimalString } from "./extraction/decimal.js";
import type { ExtractedInvoice } from "./extraction/types.js";

export interface ImportedLineItem {
    description: string;
    quantity: number;
    unitPrice: number;
    vatRate: number;
}

/**
 * Line items for the issued form. Every extracted line is kept even when the
 * document omits arithmetic: a missing quantity counts as one unit and a
 * missing unit price falls back to the declared line net amount, so nothing
 * silently disappears from the imported invoice.
 */
export function importedLineItems(
    invoice: ExtractedInvoice,
): ImportedLineItem[] {
    const items: ImportedLineItem[] = [];
    for (const item of invoice.items) {
        const quantity = parseDecimalString(item.quantity);
        const unitPrice = parseDecimalString(item.unitPrice);
        const netAmount = parseDecimalString(item.netAmount ?? "");
        const vatRate = parseDecimalString(item.vatRate);
        const resolvedQuantity =
            quantity !== null && quantity > 0 ? quantity : 1;
        items.push({
            description: item.description,
            quantity: resolvedQuantity,
            unitPrice: unitPrice ?? netAmount ?? 0,
            vatRate: vatRate ?? DEFAULT_VAT_RATE,
        });
    }
    if (items.length === 0) {
        const net =
            parseDecimalString(invoice.subtotal) ??
            parseDecimalString(invoice.amount);
        if (net !== null && net > 0) {
            const vat = parseDecimalString(invoice.vatTotal) ?? 0;
            items.push({
                description: "Imported document",
                quantity: 1,
                unitPrice: net,
                vatRate: net > 0 ? Math.round((vat / net) * 10000) / 100 : 0,
            });
        }
    }
    return items;
}

/** VAT applicability from the document, or derived from the declared totals. */
export function importedVatApplicable(
    invoice: ExtractedInvoice,
): "" | "true" | "false" {
    if (invoice.vatApplicable !== null)
        return invoice.vatApplicable ? "true" : "false";
    const vat = parseDecimalString(invoice.vatTotal);
    if (vat !== null && vat > 0) return "true";
    const net = parseDecimalString(invoice.subtotal);
    const gross = parseDecimalString(invoice.amount);
    if (net !== null && gross !== null && Math.abs(net - gross) < 0.005)
        return "false";
    return "";
}

/** Payment term in whole days between the extracted dates, if both are present. */
export function importedPaymentTermDays(
    invoice: ExtractedInvoice,
): number | null {
    if (!invoice.issueDate || !invoice.dueDate) return null;
    return invoicePaymentTermDays(invoice.issueDate, invoice.dueDate);
}

function normalizeName(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/** Matches a directory party by company ID first, then by accent-insensitive name. */
export function matchImportParty<T extends InvoicePartySource>(
    parties: readonly T[],
    fields: { name: string; ico: string },
): T | undefined {
    const ico = fields.ico.replace(/\D/g, "");
    if (ico) {
        const byIco = parties.find(
            (party) => party.ico.replace(/\D/g, "") === ico,
        );
        if (byIco) return byIco;
    }
    const name = normalizeName(fields.name);
    if (!name) return undefined;
    return parties.find((party) => normalizeName(party.name) === name);
}

/** The issued-form fields an extraction can propose, as comparable snapshots. */
export interface ImportFieldSnapshot {
    invoiceNumber: string;
    issueDate: string;
    taxPointDate: string;
    paymentTermDays: number;
    vatApplicable: string;
    itemsJson: string;
    supplierId: string;
    customerId: string;
}

const MERGE_KEYS: Array<keyof ImportFieldSnapshot> = [
    "invoiceNumber",
    "issueDate",
    "taxPointDate",
    "paymentTermDays",
    "vatApplicable",
    "itemsJson",
    "supplierId",
    "customerId",
];

/** One generic assignment keeps the snapshot keys type-safe. */
function mergeField<K extends keyof ImportFieldSnapshot>(
    key: K,
    values: ImportFieldSnapshot,
    preserved: Array<keyof ImportFieldSnapshot>,
    current: ImportFieldSnapshot,
    applied: ImportFieldSnapshot | null,
    incoming: ImportFieldSnapshot,
): void {
    const proposed = incoming[key];
    if (typeof proposed === "string" && proposed === "") return;
    const untouched = current[key] === "" || current[key] === applied?.[key];
    if (untouched) {
        values[key] = proposed;
    } else if (current[key] !== proposed) {
        preserved.push(key);
    }
}

/**
 * Applies a new extraction to fields that are still empty or unchanged since
 * the previous extraction. Fields the user edited are reported instead of
 * silently overwritten.
 */
export function mergeImportedFields(
    current: ImportFieldSnapshot,
    applied: ImportFieldSnapshot | null,
    incoming: ImportFieldSnapshot,
): {
    values: ImportFieldSnapshot;
    preserved: Array<keyof ImportFieldSnapshot>;
} {
    const values = { ...current };
    const preserved: Array<keyof ImportFieldSnapshot> = [];
    for (const key of MERGE_KEYS) {
        mergeField(key, values, preserved, current, applied, incoming);
    }
    return { values, preserved };
}

/** Human labels for preserved fields, used in the extraction notice. */
export const IMPORT_FIELD_LABELS: Record<keyof ImportFieldSnapshot, string> = {
    invoiceNumber: "invoice number",
    issueDate: "issue date",
    taxPointDate: "tax point date",
    paymentTermDays: "payment term",
    vatApplicable: "VAT applicability",
    itemsJson: "line items",
    supplierId: "supplier",
    customerId: "customer",
};
