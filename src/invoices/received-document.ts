import type { ReceivedInvoice } from '../data/invoices.js';
import { roundHalfUp } from './extraction/decimal.js';

/**
 * Presentation helpers for a received invoice's stored document breakdown.
 * Values were written by extraction; these helpers never change them, they
 * only parse and fall back to computed sums when a stored total is absent.
 */

export interface ReceivedLineItem {
    description: string;
    quantity: number;
    unitPrice: number;
    vatRate: number;
}

export function parseReceivedItems(itemsJson: string): ReceivedLineItem[] {
    if (!itemsJson) return [];
    try {
        const parsed: unknown = JSON.parse(itemsJson);
        if (!Array.isArray(parsed)) return [];
        const items: ReceivedLineItem[] = [];
        for (const entry of parsed) {
            if (!entry || typeof entry !== 'object') continue;
            const { description, quantity, unitPrice, vatRate } = entry as Record<string, unknown>;
            const parsedQuantity = Number(quantity);
            const parsedPrice = Number(unitPrice);
            const parsedRate = Number(vatRate ?? 0);
            if (!Number.isFinite(parsedQuantity) || !Number.isFinite(parsedPrice) || !Number.isFinite(parsedRate)) continue;
            items.push({
                description: typeof description === 'string' ? description : '',
                quantity: parsedQuantity,
                unitPrice: parsedPrice,
                vatRate: parsedRate,
            });
        }
        return items;
    } catch {
        return [];
    }
}

export function receivedLineNet(item: ReceivedLineItem): number {
    return roundHalfUp(item.quantity * item.unitPrice, 2);
}

export function receivedLineVat(item: ReceivedLineItem): number {
    return roundHalfUp((receivedLineNet(item) * item.vatRate) / 100, 2);
}

export interface VatGroup {
    rate: number;
    base: number;
    vat: number;
    gross: number;
}

export function receivedVatGroups(items: ReceivedLineItem[]): VatGroup[] {
    const groups = new Map<number, VatGroup>();
    for (const item of items) {
        const net = receivedLineNet(item);
        const vat = receivedLineVat(item);
        const group = groups.get(item.vatRate) ?? { rate: item.vatRate, base: 0, vat: 0, gross: 0 };
        group.base = roundHalfUp(group.base + net, 2);
        group.vat = roundHalfUp(group.vat + vat, 2);
        group.gross = roundHalfUp(group.base + group.vat, 2);
        groups.set(item.vatRate, group);
    }
    return [...groups.values()].sort((left, right) => left.rate - right.rate);
}

export interface DocumentBreakdown {
    lines: ReceivedLineItem[];
    groups: VatGroup[];
    subtotal: number;
    vatTotal: number;
    total: number;
}

/**
 * Prefers the stored document totals (what the supplier's document declared)
 * and falls back to line sums when a total was not extracted.
 */
export function receivedBreakdown(
    invoice: Pick<ReceivedInvoice, 'items' | 'subtotal' | 'vat_total' | 'amount'>,
): DocumentBreakdown {
    const lines = parseReceivedItems(invoice.items);
    const groups = receivedVatGroups(lines);
    const computedSubtotal = roundHalfUp(groups.reduce((sum, group) => sum + group.base, 0), 2);
    const computedVat = roundHalfUp(groups.reduce((sum, group) => sum + group.vat, 0), 2);
    const subtotal = invoice.subtotal > 0 ? invoice.subtotal : computedSubtotal;
    const vatTotal = invoice.vat_total > 0 ? invoice.vat_total : computedVat;
    const total = invoice.amount > 0 ? invoice.amount : roundHalfUp(subtotal + vatTotal, 2);
    return { lines, groups, subtotal, vatTotal, total };
}

export interface ExtractionInfo {
    source: string;
    origin: string;
    isdocVersion: string;
    attachmentName: string;
    provider: string;
    model: string;
    extractedAt: string;
    warnings: Array<{ code: string; field: string; message: string }>;
}

/** Parses `extraction_metadata`; malformed or absent data yields null. */
export function parseExtractionMetadata(json: string | null | undefined): ExtractionInfo | null {
    if (!json) return null;
    try {
        const parsed: unknown = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const record = parsed as Record<string, unknown>;
        const warnings = Array.isArray(record.warnings)
            ? record.warnings.flatMap((warning) => {
                if (!warning || typeof warning !== 'object') return [];
                const entry = warning as Record<string, unknown>;
                return [{
                    code: typeof entry.code === 'string' ? entry.code : '',
                    field: typeof entry.field === 'string' ? entry.field : '',
                    message: typeof entry.message === 'string' ? entry.message : '',
                }];
            })
            : [];
        return {
            source: typeof record.source === 'string' ? record.source : '',
            origin: typeof record.origin === 'string' ? record.origin : '',
            isdocVersion: typeof record.isdocVersion === 'string' ? record.isdocVersion : '',
            attachmentName: typeof record.attachmentName === 'string' ? record.attachmentName : '',
            provider: typeof record.provider === 'string' ? record.provider : '',
            model: typeof record.model === 'string' ? record.model : '',
            extractedAt: typeof record.extractedAt === 'string' ? record.extractedAt : '',
            warnings,
        };
    } catch {
        return null;
    }
}
