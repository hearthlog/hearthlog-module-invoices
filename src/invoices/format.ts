import { format, parseISO } from "date-fns";

export function formatInvoiceDate(value: string | null): string {
    if (!value) return "–";
    try {
        return format(parseISO(value), "dd MMM yyyy");
    } catch {
        return value;
    }
}

export function formatInvoiceAmount(amount: number): string {
    return new Intl.NumberFormat("cs-CZ", {
        style: "currency",
        currency: "CZK",
    }).format(amount);
}

export { formatFileSize } from '@hearthlog/sdk/format';
