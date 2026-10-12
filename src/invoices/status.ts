import { appClock } from "@hearthlog/sdk/runtime";
import { isInvoiceOverdue, invoiceToday } from "./filters.js";

/**
 * The one place a stored invoice becomes a displayed status. Both directions go
 * through here so `review` and `paid` short-circuit before the overdue check and
 * an invoice due today never reads as overdue. The SQL list projection mirrors
 * these rules for rows that never reach a component.
 */
export function invoiceStatusOf(
    invoice: { status: string; due_date: string | null },
    today: string = invoiceToday(appClock.now()),
): string {
    if (invoice.status === "paid" || invoice.status === "review") return invoice.status;
    return isInvoiceOverdue(invoice, today) ? "overdue" : invoice.status;
}
