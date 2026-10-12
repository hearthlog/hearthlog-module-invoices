import type { Invoice } from "../data/invoices.js";

/**
 * Local calendar date (YYYY-MM-DD) for an instant. This is the app's notion of
 * "today": the SQL list query takes the same string, so a row is never overdue
 * in the table but current in a filter (or the reverse).
 */
export function invoiceToday(now: Date | string = new Date()): string {
    const date = typeof now === "string" ? new Date(now) : now;
    if (Number.isNaN(date.getTime())) return "";
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The calendar date of a stored value. Issued invoices store a full instant and
 * received invoices store a plain date, so both reduce to the same ten digits.
 * Keeping the comparison date-only means a stored timezone can never move the
 * overdue boundary by a day.
 */
function invoiceDay(value: string | null | undefined): string {
    return (value ?? "").slice(0, 10);
}

/**
 * An invoice is overdue once its due date is strictly before today, so an
 * invoice due today is not overdue and the stored timestamp's timezone never
 * moves the boundary. Mirrors the `status` projection in the list query.
 */
export function isInvoiceOverdue(
    invoice: Pick<Invoice, "status" | "due_date">,
    today: string,
): boolean {
    if (invoice.status === "paid") return false;
    const due = invoiceDay(invoice.due_date);
    return Boolean(due && today) && due < today;
}
