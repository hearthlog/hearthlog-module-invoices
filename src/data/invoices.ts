import type { Invoice, Invoiceparty, ReceivedInvoice } from '@hearthlog/sdk/data';
import type { ReadModelSession } from '@hearthlog/sdk/data';
import { withTimeout } from '@hearthlog/sdk/data';
import { sql } from 'kysely';
import {
    queryInvoiceList,
    queryInvoiceSelection,
    queryInvoiceSelectionIds,
    queryInvoiceOverview,
    type InvoiceListRequest,
    type InvoiceSelectionRequest,
} from './invoice-list.js';

export type { Invoice, Invoiceparty, ReceivedInvoice };

export type {
    InvoiceListFilters,
    InvoiceListRequest,
    InvoiceListResult,
    InvoiceSelectionRequest,
    InvoiceSelectionScope,
    InvoiceSelectionSummary,
} from './invoice-list.js';

const DB_TIMEOUT_MS = 5000;

/** A received invoice as the expense type suggestion needs it. */
export interface ExpenseTypeTarget {
    /** Echoed back so callers match without normalising. */
    id: string;
    supplierIco: string;
    supplierName: string;
}

/** The expense type an earlier invoice of the same supplier was given. */
export interface ExpenseTypeFromHistory {
    id: string;
    expenseType: string;
    /** `ico` when the supplier's IČO matched, `name` when only the name did. */
    via: 'ico' | 'name';
}

/** A received invoice without an expense type, with what the decision model reads. */
export interface UntypedReceivedInvoice {
    id: string;
    supplierName: string;
    supplierIco: string;
    description: string;
    invoiceNumber: string;
    issueDate: string;
    amount: number;
    currency: string;
    /** Up to 10 line item descriptions, taken in SQL. */
    lines: string[];
}

export function createInvoiceRepository(session: ReadModelSession) {
    return {
        queryList(request: InvoiceListRequest) {
            return withTimeout(queryInvoiceList(session, request), DB_TIMEOUT_MS, 'Invoice list query timed out');
        },
        querySelection(request: InvoiceSelectionRequest) {
            return withTimeout(queryInvoiceSelection(session, request), DB_TIMEOUT_MS, 'Invoice selection query timed out');
        },
        queryOverview(request: { today: string; periodStart: string }) {
            return withTimeout(queryInvoiceOverview(session, request), DB_TIMEOUT_MS, 'Invoice overview query timed out');
        },
        querySelectionIds(request: InvoiceSelectionRequest) {
            return withTimeout(queryInvoiceSelectionIds(session, request), DB_TIMEOUT_MS, 'Invoice selection query timed out');
        },
        /** Whole records for a resolved selection, so bulk actions never need every row. */
        getInvoicesByIds(ids: string[]): Promise<Invoice[]> {
            if (!ids.length) return Promise.resolve([]);
            return withTimeout(
                session.selectFrom('invoices')
                    .selectAll()
                    .where('id', 'in', ids)
                    .execute(),
                DB_TIMEOUT_MS,
                'Invoice query timed out',
            );
        },

        getReceivedInvoicesByIds(ids: string[]): Promise<ReceivedInvoice[]> {
            if (!ids.length) return Promise.resolve([]);
            return withTimeout(
                session.selectFrom('received_invoices')
                    .selectAll()
                    .where('id', 'in', ids)
                    .execute(),
                DB_TIMEOUT_MS,
                'Received invoice query timed out',
            );
        },
        getInvoices(): Promise<Invoice[]> {
            return withTimeout(
                session.selectFrom('invoices')
                    .selectAll()
                    .orderBy('issue_date', 'desc')
                    .orderBy('created_at', 'desc')
                    .execute(),
                DB_TIMEOUT_MS,
                'Invoice query timed out',
            );
        },

        /**
         * What a new invoice starts from on a phone: the latest issued number and
         * supplier, and the customers invoiced most recently, newest first.
         */
        async getNewInvoiceDefaults(): Promise<{ lastNumber: string; lastSupplierId: string; recentCustomerIds: string[] }> {
            const [latest, customers] = await withTimeout(
                Promise.all([
                    session.selectFrom('invoices')
                        .select(['invoice_number', 'supplier_id'])
                        .orderBy('created_at', 'desc')
                        .orderBy('id', 'desc')
                        .limit(1)
                        .executeTakeFirst(),
                    session.selectFrom('invoices')
                        .select(({ fn }) => ['customer_id', fn.max('created_at').as('last_at')])
                        .where('customer_id', '!=', '')
                        .groupBy('customer_id')
                        .orderBy('last_at', 'desc')
                        .limit(4)
                        .execute(),
                ]),
                DB_TIMEOUT_MS,
                'Invoice defaults query timed out',
            );
            return {
                lastNumber: latest?.invoice_number ?? '',
                lastSupplierId: latest?.supplier_id ?? '',
                recentCustomerIds: customers.map((row) => String(row.customer_id)),
            };
        },

        /** The payment term of the last invoice to a customer, in days, or null. */
        async getCustomerPaymentTerm(customerId: string): Promise<number | null> {
            const row = await withTimeout(
                session.selectFrom('invoices')
                    .select(sql<number | null>`CAST(julianday(substr(due_date, 1, 10)) - julianday(substr(issue_date, 1, 10)) AS INTEGER)`.as('term'))
                    .where('customer_id', '=', customerId)
                    .where('due_date', '!=', '')
                    .where('issue_date', '!=', '')
                    .orderBy('created_at', 'desc')
                    .limit(1)
                    .executeTakeFirst(),
                DB_TIMEOUT_MS,
                'Customer payment term query timed out',
            );
            const term = row?.term;
            return term === null || term === undefined || !Number.isFinite(Number(term)) || Number(term) < 0 ? null : Number(term);
        },

        /** The unpaid invoice with the nearest due date, chosen by SQLite. */
        async getNextUnpaidInvoice(): Promise<Invoice | null> {
            const row = await withTimeout(
                session.selectFrom('invoices')
                    .selectAll()
                    .where('status', '!=', 'paid')
                    .where('due_date', 'is not', null)
                    .where('due_date', '!=', '')
                    .orderBy('due_date', 'asc')
                    .orderBy('id', 'asc')
                    .limit(1)
                    .executeTakeFirst(),
                DB_TIMEOUT_MS,
                'Next unpaid invoice query timed out',
            );
            return row ?? null;
        },

        /** Unpaid rows in a resolved selection; SQL drops the already-paid ids. */
        async getUnpaidInvoicesByIds(ids: string[]): Promise<Invoice[]> {
            if (!ids.length) return [];
            return withTimeout(
                session.selectFrom('invoices')
                    .selectAll()
                    .where('id', 'in', ids)
                    .where('status', '!=', 'paid')
                    .execute(),
                DB_TIMEOUT_MS,
                'Unpaid invoice query timed out',
            );
        },

        /** Unpaid rows in a resolved received-invoice selection. */
        async getUnpaidReceivedInvoicesByIds(ids: string[]): Promise<ReceivedInvoice[]> {
            if (!ids.length) return [];
            return withTimeout(
                session.selectFrom('received_invoices')
                    .selectAll()
                    .where('id', 'in', ids)
                    .where('status', '!=', 'paid')
                    .execute(),
                DB_TIMEOUT_MS,
                'Unpaid received invoice query timed out',
            );
        },

        getReceivedInvoices(): Promise<ReceivedInvoice[]> {
            return withTimeout(
                session.selectFrom('received_invoices')
                    .selectAll()
                    .orderBy('created_at', 'desc')
                    .execute(),
                DB_TIMEOUT_MS,
                'Received invoice query timed out',
            );
        },

        async getReceivedInvoice(id: string): Promise<ReceivedInvoice | null> {
            return (await withTimeout(
                session.selectFrom('received_invoices')
                    .selectAll()
                    .where('id', '=', id)
                    .executeTakeFirst(),
                DB_TIMEOUT_MS,
                'Received invoice query timed out',
            )) ?? null;
        },

        /**
         * The history rule for received invoices: the type last used for the
         * same supplier. The IČO decides when both have one; otherwise the
         * supplier name (case and surrounding spaces ignored). Ranking runs in SQL.
         */
        async expenseTypeFromHistory(targets: ExpenseTypeTarget[]): Promise<ExpenseTypeFromHistory[]> {
            const wanted = targets.filter((target) => target.supplierIco.trim() !== '' || target.supplierName.trim() !== '');
            if (wanted.length === 0) return [];
            const result = await withTimeout(
                session.execute(sql<{ id: string; expense_type: string; via: number | string }>`
                    WITH targets(id, ico, name) AS (
                        VALUES ${sql.join(wanted.map((target) => sql`(${target.id}, ${target.supplierIco.trim()}, ${target.supplierName.trim()})`))}
                    ),
                    matches AS (
                        SELECT targets.id AS id, earlier.expense_type AS expense_type, 1 AS via,
                            earlier.updated_at AS at, earlier.id AS earlier_id
                        FROM targets
                        JOIN ${session.table('received_invoices')} AS earlier
                            ON targets.ico != '' AND TRIM(earlier.supplier_ico) = targets.ico
                        WHERE COALESCE(earlier.expense_type, '') != '' AND earlier.id != targets.id
                        UNION ALL
                        SELECT targets.id, earlier.expense_type, 2, earlier.updated_at, earlier.id
                        FROM targets
                        JOIN ${session.table('received_invoices')} AS earlier
                            ON targets.name != '' AND LOWER(TRIM(earlier.supplier_name)) = LOWER(targets.name)
                        WHERE COALESCE(earlier.expense_type, '') != '' AND earlier.id != targets.id
                    ),
                    ranked AS (
                        SELECT id, expense_type, via,
                            ROW_NUMBER() OVER (PARTITION BY id ORDER BY via ASC, at DESC, earlier_id ASC) AS place
                        FROM matches
                    )
                    SELECT id, expense_type, via FROM ranked WHERE place = 1
                `),
                DB_TIMEOUT_MS,
                'Expense type history query timed out',
            );
            return result.rows.map((row) => ({
                id: String(row.id),
                expenseType: String(row.expense_type),
                via: Number(row.via) === 1 ? 'ico' : 'name',
            }));
        },

        /** Received invoices that have no expense type yet, newest first, with up to 10 line descriptions each. */
        async getReceivedWithoutExpenseType(): Promise<UntypedReceivedInvoice[]> {
            const result = await withTimeout(
                session.execute(sql<{
                    id: string; supplier_name: string | null; supplier_ico: string | null; description: string | null;
                    invoice_number: string | null; issue_date: string | null; amount: number | string | null;
                    currency: string | null; lines: string | null;
                }>`
                    SELECT i.id, i.supplier_name, i.supplier_ico, i.description, i.invoice_number, i.issue_date, i.amount, i.currency,
                        (SELECT json_group_array(line.description) FROM (
                            SELECT json_extract(j.value, '$.description') AS description
                            FROM json_each(CASE WHEN json_valid(i.items) AND json_type(i.items) = 'array' THEN i.items ELSE '[]' END) AS j
                            WHERE COALESCE(json_extract(j.value, '$.description'), '') != ''
                            LIMIT 10
                        ) AS line) AS lines
                    FROM ${session.table('received_invoices')} AS i
                    WHERE COALESCE(i.expense_type, '') = ''
                    ORDER BY i.issue_date DESC, i.created_at DESC, i.id ASC
                `),
                DB_TIMEOUT_MS,
                'Untyped received invoice query timed out',
            );
            return result.rows.map((row) => {
                let lines: unknown = [];
                try { lines = JSON.parse(row.lines ?? '[]'); } catch { /* an unreadable list is no lines */ }
                return {
                    id: String(row.id),
                    supplierName: row.supplier_name ?? '',
                    supplierIco: row.supplier_ico ?? '',
                    description: row.description ?? '',
                    invoiceNumber: row.invoice_number ?? '',
                    issueDate: (row.issue_date ?? '').slice(0, 10),
                    amount: Number(row.amount ?? 0),
                    currency: row.currency || 'CZK',
                    lines: Array.isArray(lines) ? lines.filter((line): line is string => typeof line === 'string') : [],
                };
            });
        },

        /** How many received invoices have no expense type yet. */
        async countReceivedWithoutExpenseType(): Promise<number> {
            const result = await withTimeout(
                session.selectFrom('received_invoices')
                    .select(({ fn }) => fn.countAll().as('count'))
                    .where(sql<boolean>`COALESCE(expense_type, '') = ''`)
                    .executeTakeFirst(),
                DB_TIMEOUT_MS,
                'Untyped received invoice count timed out',
            );
            return Number(result?.count ?? 0);
        },

        /**
         * Rows whose number matches a normalized key. The caller narrows by
         * counterparty; numbers are stored trimmed, but the uppercase compare
         * keeps legacy values without depending on the input's casing.
         */
        findInvoicesByNumber(
            normalizedNumber: string,
        ): Promise<Invoice[]> {
            if (!normalizedNumber) return Promise.resolve([]);
            return withTimeout(
                session.selectFrom('invoices')
                    .selectAll()
                    .where(
                        sql<boolean>`UPPER(TRIM(invoice_number)) = ${normalizedNumber}`,
                    )
                    .execute(),
                DB_TIMEOUT_MS,
                'Invoice duplicate query timed out',
            );
        },

        findReceivedInvoicesByNumber(
            normalizedNumber: string,
        ): Promise<ReceivedInvoice[]> {
            if (!normalizedNumber) return Promise.resolve([]);
            return withTimeout(
                session.selectFrom('received_invoices')
                    .selectAll()
                    .where(
                        sql<boolean>`UPPER(TRIM(invoice_number)) = ${normalizedNumber}`,
                    )
                    .execute(),
                DB_TIMEOUT_MS,
                'Received invoice duplicate query timed out',
            );
        },

        async getInvoice(id: string): Promise<Invoice | null> {
            const invoice = await withTimeout(
                session.selectFrom('invoices')
                    .selectAll()
                    .where('id', '=', id)
                    .executeTakeFirst(),
                DB_TIMEOUT_MS,
                'Invoice query timed out',
            );
            return invoice ?? null;
        },

        getInvoiceParties(): Promise<Invoiceparty[]> {
            return withTimeout(
                session.selectFrom('invoice_parties')
                    .selectAll()
                    .orderBy('name', 'asc')
                    .execute(),
                DB_TIMEOUT_MS,
                'Invoice party query timed out',
            );
        },
    };
}
