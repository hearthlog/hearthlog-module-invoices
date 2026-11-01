import { format, parseISO } from "date-fns";

export function formatInvoiceDate(value: string | null): string {
    if (!value) return "–";
    try {
        return format(parseISO(value), "dd MMM yyyy");
    } catch {
        return value;
    }
}

/** Up to two initials for a monogram tile; legal suffixes (s.r.o., a.s., GmbH…) do not count. */
export function partyInitials(name: string): string {
    return name
        .replace(/[,.]/g, " ")
        .split(/\s+/)
        .filter((word) => word && !/^(s|r|o|a|spol|ltd|gmbh|inc)$/i.test(word))
        .slice(0, 2)
        .map((word) => word[0]!.toLocaleUpperCase("cs-CZ"))
        .join("");
}

/**
 * How far an unsettled invoice is from its due date: "in 6 days", "today",
 * "4 days late". Settled and unknown dates say nothing.
 */
export function dueRelative(due: string, today: string, status: string): { text: string; late: boolean } | null {
    if (status === "paid" || !due || !today) return null;
    const days = Math.round((Date.parse(`${due.slice(0, 10)}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
    if (Number.isNaN(days)) return null;
    if (days === 0) return { text: "today", late: false };
    if (days > 0) return { text: `in ${days} day${days === 1 ? "" : "s"}`, late: false };
    return { text: `${-days} day${days === -1 ? "" : "s"} late`, late: true };
}

export function formatInvoiceAmount(amount: number): string {
    return new Intl.NumberFormat("cs-CZ", {
        style: "currency",
        currency: "CZK",
    }).format(amount);
}

export { formatFileSize } from '@hearthlog/sdk/format';
