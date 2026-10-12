import { sql } from 'kysely';
import { withTimeout, type ReadModelSession } from '@hearthlog/sdk/data';

const DB_TIMEOUT_MS = 5000;

function toCount(value: number | string | null | undefined): number {
    const count = Number(value ?? 0);
    return Number.isFinite(count) ? count : 0;
}

export interface UpcomingInvoice {
    id: string;
    number: string;
    /** Due date, `YYYY-MM-DD`. */
    due: string;
    /** Customer name, empty when unknown. */
    party: string;
}

/** Counts and dates of late work; overdue follows the invoice list's derived status. */
export function createInvoiceAttentionRepository(session: ReadModelSession) {
    return {
        /** Issued, unpaid invoices falling due in `[from, until]` (date-only), earliest first. */
        async upcomingInvoices(from: string, until: string, limit: number): Promise<UpcomingInvoice[]> {
            const result = await withTimeout(
                session.execute(sql<UpcomingInvoice>`
                    SELECT i.id AS id, i.invoice_number AS number, SUBSTR(i.due_date, 1, 10) AS due,
                        COALESCE(CASE WHEN json_valid(i.customer_snapshot)
                            THEN json_extract(i.customer_snapshot, '$.name') END, p.name, '') AS party
                    FROM ${session.table('invoices')} AS i
                    LEFT JOIN ${session.table('invoice_parties')} AS p
                        ON p.tenant_id = i.tenant_id AND p.log_id = i.log_id AND p.id = i.customer_id
                    WHERE i.status NOT IN ('paid', 'draft')
                        AND COALESCE(i.document_state, '') != 'draft'
                        AND COALESCE(i.due_date, '') != ''
                        AND SUBSTR(i.due_date, 1, 10) >= ${from}
                        AND SUBSTR(i.due_date, 1, 10) <= ${until}
                    ORDER BY due ASC, i.invoice_number ASC
                    LIMIT ${limit}
                `),
                DB_TIMEOUT_MS,
                'Upcoming invoice query timed out',
            );
            return result.rows;
        },

        /** Issued invoices that are unpaid and past their due date (date-only). */
        async countOverdueInvoices(today: string): Promise<number> {
            const result = await withTimeout(
                session.execute(sql<{ count: number | string | null }>`
                    SELECT COUNT(*) AS count
                    FROM ${session.table('invoices')} AS i
                    WHERE i.status != 'paid'
                        AND COALESCE(i.due_date, '') != ''
                        AND SUBSTR(i.due_date, 1, 10) < ${today}
                `),
                DB_TIMEOUT_MS,
                'Overdue invoice count timed out',
            );
            return toCount(result.rows[0]?.count);
        },
    };
}
