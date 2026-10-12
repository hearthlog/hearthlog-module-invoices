import { addDays, format, parseISO } from 'date-fns';
import type { AttentionContribution, AttentionReminder } from '@hearthlog/contracts';
import { queryDatabase } from '@hearthlog/sdk/data';
import { REMINDER_HOUR } from '@hearthlog/sdk/runtime';
import type { UpcomingInvoice } from './data/attention.js';

/** How far ahead invoices are scheduled; the shell keeps the nearest 60. */
const INVOICE_HORIZON_DAYS = 30;
const DAY = 'yyyy-MM-dd';

/**
 * Rows arrive already filtered by SQL; this only words them. An invoice
 * reminds the day before and on its due date. Times already in the past are
 * dropped by the shell.
 */
export function invoiceReminders(invoices: readonly UpcomingInvoice[]): AttentionReminder[] {
    return invoices.flatMap((invoice) => {
        const body = invoice.party || 'Issued invoice';
        const eve = format(addDays(parseISO(invoice.due), -1), DAY);
        return [
            {
                id: `invoice:${invoice.id}:eve`,
                title: `Invoice ${invoice.number} is due tomorrow`,
                body,
                at: `${eve}T${REMINDER_HOUR}`,
                path: '/invoices',
            },
            {
                id: `invoice:${invoice.id}:due`,
                title: `Invoice ${invoice.number} is due today`,
                body,
                at: `${invoice.due}T${REMINDER_HOUR}`,
                path: '/invoices',
            },
        ];
    });
}

/** Overdue invoices badge the navigation; coming-due invoices remind on the device. */
export const attention: AttentionContribution = {
    async badges({ today }) {
        const count = await queryDatabase((repositories) => repositories.invoiceAttention.countOverdueInvoices(today));
        return [{
            ids: ['invoices', 'invoices.issued'],
            count,
            tone: 'negative',
            label: `${count} overdue ${count === 1 ? 'invoice' : 'invoices'}`,
        }];
    },
    async reminders({ today }) {
        const invoices = await queryDatabase((repositories) =>
            repositories.invoiceAttention.upcomingInvoices(format(today, DAY), format(addDays(today, INVOICE_HORIZON_DAYS), DAY), 40));
        return invoiceReminders(invoices);
    },
};
