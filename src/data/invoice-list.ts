import { sql, type RawBuilder } from 'kysely';
import type { ReadModelSession } from '@hearthlog/sdk/data';
import { EXPENSE_TYPE_UNSET, type InvoiceListFilters, type InvoiceListRow } from '../invoices/list-contracts.js';

export type { InvoiceListFilters } from '../invoices/list-contracts.js';

export interface InvoiceListRequest {
    direction: 'issued' | 'received';
    filters: InvoiceListFilters;
    sort: { id: string; desc: boolean };
    /** Local calendar date (YYYY-MM-DD); overdue is a date-only comparison. */
    today: string;
    /** 1-based. The query clamps it to the available range. */
    page: number;
    pageSize: number;
}

/**
 * Which rows an action applies to: either an explicit set of ids, or every row
 * matching the current filters with a few carved out ("select all matching").
 */
export interface InvoiceSelectionScope {
    ids: string[] | null;
    filters: InvoiceListFilters;
    excludedIds: string[];
}

export interface InvoiceSelectionRequest {
    direction: 'issued' | 'received';
    today: string;
    scope: InvoiceSelectionScope;
}

export interface InvoiceSelectionTotals {
    currency: string;
    before: number;
    after: number;
    knownBefore: number;
    knownAfter: number;
    missingBefore: number;
    missingAfter: number;
}

export interface InvoiceSelectionSummary {
    count: number;
    /** Selected rows that need review before they can be marked paid. */
    blocked: number;
    /** Selected rows that are not paid yet. */
    unpaid: number;
    totals: InvoiceSelectionTotals[];
}
export interface InvoiceListResult {
    rows: InvoiceListRow[];
    /** Rows matching the active filters. */
    matchCount: number;
    /** Rows in this direction, ignoring filters; drives the "nothing yet" empty state. */
    totalCount: number;
    page: number;
    pageSize: number;
    pageCount: number;
    parties: string[];
    issuedDates: string[];
    dueDates: string[];
    taxPointDates: string[];
    beforeBounds: { min: number; max: number } | null;
    afterBounds: { min: number; max: number } | null;
}

interface InvoiceFacets {
    totalCount: number;
    matchCount: number;
    parties: string[];
    issuedDates: string[];
    dueDates: string[];
    taxPointDates: string[];
    beforeBounds: { min: number; max: number } | null;
    afterBounds: { min: number; max: number } | null;
}

type Row = Record<string, unknown>;

/**
 * The row projection shared by every query below. `afterVat`, `party`, `status`
 * and `currency` are computed exactly once, here, so a row can never be sorted
 * or filtered by one value while a different one is displayed.
 */
const ROW_COLUMNS = sql`id, invoiceNumber, party, issued, due, taxPoint, beforeVat, afterVat, currency, status, documentState, storageStatus, expenseType`;

function baseRows(
    session: ReadModelSession,
    direction: InvoiceListRequest['direction'],
    today: string,
): RawBuilder<unknown> {
    const validLine = sql`CASE WHEN j.type = 'object' THEN
        COALESCE(json_type(j.value, '$.quantity'), '') IN ('integer', 'real')
        AND COALESCE(json_type(j.value, '$.unitPrice'), '') IN ('integer', 'real')
        AND COALESCE(json_type(j.value, '$.vatRate'), 'null') IN ('integer', 'real', 'null')
        ELSE FALSE END`;
    if (direction === 'issued') {
        return sql`
            WITH line_totals AS (
                SELECT i.id, COUNT(j.key) AS item_count,
                    SUM(CASE WHEN j.key IS NOT NULL AND NOT (${validLine}) THEN 1 ELSE 0 END) AS invalid_count,
                    SUM(CASE WHEN ${validLine} THEN CAST(json_extract(j.value, '$.quantity') AS REAL)
                        * CAST(json_extract(j.value, '$.unitPrice') AS REAL)
                        * (1 + COALESCE(CAST(json_extract(j.value, '$.vatRate') AS REAL), 0) / 100) END) AS payable
                FROM ${session.table('invoices')} AS i
                LEFT JOIN json_each(CASE WHEN json_valid(i.items) AND json_type(i.items) = 'array' THEN i.items ELSE '[]' END) AS j ON TRUE
                GROUP BY i.id
            ), invoice_rows AS (
                SELECT i.id, i.invoice_number AS invoiceNumber,
                    COALESCE(CASE WHEN json_valid(i.customer_snapshot)
                        THEN json_extract(i.customer_snapshot, '$.name') END, p.name, '') AS party,
                    i.issue_date AS issued, COALESCE(i.due_date, '') AS due,
                    i.tax_point_date AS taxPoint,
                    i.amount AS beforeVat,
                    CASE WHEN lt.item_count > 0 AND lt.invalid_count = 0 THEN ROUND(lt.payable, 2) ELSE i.amount END AS afterVat,
                    'CZK' AS currency,
                    CASE WHEN i.status != 'paid' AND COALESCE(i.due_date, '') != ''
                        AND SUBSTR(i.due_date, 1, 10) < ${today}
                        THEN 'overdue' ELSE i.status END AS status,
                    CASE WHEN i.document_state IN ('draft', 'issued') THEN i.document_state
                        WHEN COALESCE(i.document_state, '') != '' THEN NULL
                        WHEN i.status = 'draft' THEN 'draft' ELSE 'issued' END AS documentState,
                    CASE WHEN COALESCE(i.file_id, '') != '' AND COALESCE(i.storage_status, '') != 'uploaded'
                        THEN COALESCE(i.storage_status, '') END AS storageStatus,
                    '' AS expenseType
                FROM ${session.table('invoices')} AS i
                LEFT JOIN line_totals AS lt ON lt.id = i.id
                LEFT JOIN ${session.table('invoice_parties')} AS p
                    ON p.tenant_id = i.tenant_id AND p.log_id = i.log_id
                    AND p.id = COALESCE(
                        NULLIF((SELECT m.merged_into FROM ${session.table('invoice_parties')} AS m
                                WHERE m.id = i.customer_id), ''),
                        i.customer_id)
            )
        `;
    }
    return sql`
        WITH line_totals AS (
            SELECT i.id,
                SUM(CASE WHEN ${validLine} THEN 1 ELSE 0 END) AS item_count,
                SUM(CASE WHEN ${validLine} THEN ROUND(CAST(json_extract(j.value, '$.quantity') AS REAL)
                    * CAST(json_extract(j.value, '$.unitPrice') AS REAL), 2) END) AS net,
                SUM(CASE WHEN ${validLine} THEN ROUND(ROUND(CAST(json_extract(j.value, '$.quantity') AS REAL)
                    * CAST(json_extract(j.value, '$.unitPrice') AS REAL), 2)
                    * COALESCE(CAST(json_extract(j.value, '$.vatRate') AS REAL), 0) / 100, 2) END) AS vat
            FROM ${session.table('received_invoices')} AS i
            LEFT JOIN json_each(CASE WHEN json_valid(i.items) AND json_type(i.items) = 'array' THEN i.items ELSE '[]' END) AS j ON TRUE
            GROUP BY i.id
        ), invoice_amounts AS (
            SELECT i.*,
                CASE WHEN i.subtotal > 0 THEN i.subtotal ELSE COALESCE(lt.net, 0) END AS net_total,
                CASE WHEN i.vat_total > 0 THEN i.vat_total ELSE COALESCE(lt.vat, 0) END AS vat_total_value,
                lt.item_count
            FROM ${session.table('received_invoices')} AS i
            LEFT JOIN line_totals AS lt ON lt.id = i.id
        ), invoice_rows AS (
            SELECT i.id, COALESCE(NULLIF(i.invoice_number, ''), 'Pending review') AS invoiceNumber,
                COALESCE(NULLIF(i.supplier_name, ''), 'Supplier needed') AS party,
                i.issue_date AS issued, i.due_date AS due,
                i.tax_point_date AS taxPoint,
                CASE WHEN i.subtotal > 0 OR i.item_count > 0 THEN i.net_total END AS beforeVat,
                CASE WHEN i.amount > 0 THEN i.amount
                    WHEN i.item_count > 0 THEN ROUND(i.net_total + i.vat_total_value, 2) END AS afterVat,
                COALESCE(NULLIF(i.currency, ''), 'CZK') AS currency,
                CASE WHEN i.status = 'review' THEN 'review'
                    WHEN i.status = 'paid' THEN 'paid'
                    WHEN i.status = 'unpaid' AND COALESCE(i.due_date, '') != ''
                        AND SUBSTR(i.due_date, 1, 10) < ${today}
                        THEN 'overdue' ELSE 'unpaid' END AS status,
                NULL AS documentState,
                CASE WHEN COALESCE(i.storage_status, '') != 'uploaded'
                    THEN COALESCE(i.storage_status, '') END AS storageStatus,
                COALESCE(i.expense_type, '') AS expenseType
            FROM invoice_amounts AS i
        )
    `;
}

/** The filter predicate without a WHERE keyword, so it can also count matches. */
function filterPredicate(filters: InvoiceListFilters): RawBuilder<unknown> {
    const clauses: RawBuilder<unknown>[] = [];
    const search = filters.search.trim();
    if (search) {
        clauses.push(sql`(INSTR(LOWER(invoiceNumber), LOWER(${search})) > 0 OR INSTR(LOWER(party), LOWER(${search})) > 0)`);
    }
    if (filters.invoiceNumber.trim()) clauses.push(sql`INSTR(LOWER(invoiceNumber), LOWER(${filters.invoiceNumber.trim()})) > 0`);
    if (filters.party) clauses.push(sql`party = ${filters.party}`);
    if (filters.status !== 'all') {
        if (filters.status === 'outstanding') clauses.push(sql`status != 'paid'`);
        else if (filters.status === 'unpaid') clauses.push(sql`status IN ('unpaid', 'overdue')`);
        else clauses.push(sql`status = ${filters.status}`);
    }
    if (filters.expenseType === EXPENSE_TYPE_UNSET) clauses.push(sql`expenseType = ''`);
    else if (filters.expenseType) clauses.push(sql`expenseType = ${filters.expenseType}`);
    if (filters.issued.from) clauses.push(sql`SUBSTR(issued, 1, 10) >= ${filters.issued.from}`);
    if (filters.issued.to) clauses.push(sql`SUBSTR(issued, 1, 10) <= ${filters.issued.to}`);
    if (filters.due.from) clauses.push(sql`SUBSTR(due, 1, 10) >= ${filters.due.from}`);
    if (filters.due.to) clauses.push(sql`SUBSTR(due, 1, 10) <= ${filters.due.to}`);
    if (filters.taxPoint.from) clauses.push(sql`SUBSTR(taxPoint, 1, 10) >= ${filters.taxPoint.from}`);
    if (filters.taxPoint.to) clauses.push(sql`SUBSTR(taxPoint, 1, 10) <= ${filters.taxPoint.to}`);
    const beforeMin = filters.beforeVat.min === '' ? null : Number(filters.beforeVat.min);
    const beforeMax = filters.beforeVat.max === '' ? null : Number(filters.beforeVat.max);
    const afterMin = filters.afterVat.min === '' ? null : Number(filters.afterVat.min);
    const afterMax = filters.afterVat.max === '' ? null : Number(filters.afterVat.max);
    if (beforeMin !== null && Number.isFinite(beforeMin)) clauses.push(sql`beforeVat >= ${beforeMin}`);
    if (beforeMax !== null && Number.isFinite(beforeMax)) clauses.push(sql`beforeVat <= ${beforeMax}`);
    if (afterMin !== null && Number.isFinite(afterMin)) clauses.push(sql`afterVat >= ${afterMin}`);
    if (afterMax !== null && Number.isFinite(afterMax)) clauses.push(sql`afterVat <= ${afterMax}`);
    return clauses.length ? sql.join(clauses, sql` AND `) : sql`TRUE`;
}

/** Resolves a selection to a predicate over `invoice_rows`. */
function selectionPredicate(scope: InvoiceSelectionScope): RawBuilder<unknown> {
    const clauses: RawBuilder<unknown>[] = [
        scope.ids === null
            ? filterPredicate(scope.filters)
            : sql`id IN (SELECT value FROM json_each(${JSON.stringify(scope.ids)}))`,
    ];
    if (scope.excludedIds.length) {
        clauses.push(sql`id NOT IN (SELECT value FROM json_each(${JSON.stringify(scope.excludedIds)}))`);
    }
    return clauses.length > 1 ? sql.join(clauses, sql` AND `) : clauses[0]!;
}

function orderClause(sort: InvoiceListRequest['sort']): RawBuilder<unknown> {
    const columns: Record<string, RawBuilder<unknown>> = {
        invoiceNumber: sql`invoiceNumber COLLATE NOCASE`,
        party: sql`party COLLATE NOCASE`,
        issued: sql`issued`,
        due: sql`due`,
        beforeVat: sql`beforeVat`,
        afterVat: sql`afterVat`,
        status: sql`status`,
    };
    const column = columns[sort.id] ?? columns.issued;
    return sql`ORDER BY ${column} ${sort.desc ? sql`DESC` : sql`ASC`}, id ASC`;
}

function toRow(row: Row): InvoiceListRow {
    const documentState = row.documentState === 'draft' || row.documentState === 'issued' ? row.documentState : null;
    return {
        id: String(row.id),
        invoiceNumber: String(row.invoiceNumber ?? ''),
        party: String(row.party ?? ''),
        issued: String(row.issued ?? ''),
        due: String(row.due ?? ''),
        taxPoint: String(row.taxPoint ?? ''),
        beforeVat: row.beforeVat === null || row.beforeVat === undefined ? null : Number(row.beforeVat),
        afterVat: row.afterVat === null || row.afterVat === undefined ? null : Number(row.afterVat),
        currency: String(row.currency ?? 'CZK'),
        status: String(row.status ?? ''),
        documentState,
        storageStatus: row.storageStatus === null || row.storageStatus === undefined ? null : String(row.storageStatus),
        expenseType: String(row.expenseType ?? ''),
    };
}

function boundsOf(min: unknown, max: unknown): { min: number; max: number } | null {
    return min === null || min === undefined || max === null || max === undefined
        ? null
        : { min: Number(min), max: Number(max) };
}

function stringList(raw: unknown, pattern?: RegExp): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(String(raw ?? '[]'));
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
        .filter((entry): entry is string => typeof entry === 'string' && (!pattern || pattern.test(entry)))
        .sort((left, right) => left.localeCompare(right));
}

/**
 * Facets are read before the page so an out-of-range page number (a stale link,
 * a filter that shrank the result set) clamps instead of rendering an empty
 * table next to a "page 4 of 2" footer.
 */
async function queryInvoiceFacets(
    session: ReadModelSession,
    request: InvoiceListRequest,
): Promise<InvoiceFacets> {
    const result = await session.execute(sql<Row>`${baseRows(session, request.direction, request.today)}
        SELECT COUNT(*) AS totalCount,
            COALESCE(SUM(CASE WHEN ${filterPredicate(request.filters)} THEN 1 ELSE 0 END), 0) AS matchCount,
            MIN(beforeVat) AS beforeMin, MAX(beforeVat) AS beforeMax,
            MIN(afterVat) AS afterMin, MAX(afterVat) AS afterMax,
            json_group_array(DISTINCT party) AS parties,
            json_group_array(DISTINCT NULLIF(SUBSTR(issued, 1, 10), '')) AS issuedDates,
            json_group_array(DISTINCT NULLIF(SUBSTR(due, 1, 10), '')) AS dueDates,
            json_group_array(DISTINCT NULLIF(SUBSTR(taxPoint, 1, 10), '')) AS taxPointDates
        FROM invoice_rows
    `);
    const row = result.rows[0];
    return {
        totalCount: Number(row?.totalCount ?? 0),
        matchCount: Number(row?.matchCount ?? 0),
        parties: stringList(row?.parties),
        issuedDates: stringList(row?.issuedDates, /^\d{4}-\d{2}-\d{2}$/),
        dueDates: stringList(row?.dueDates, /^\d{4}-\d{2}-\d{2}$/),
        taxPointDates: stringList(row?.taxPointDates, /^\d{4}-\d{2}-\d{2}$/),
        beforeBounds: boundsOf(row?.beforeMin, row?.beforeMax),
        afterBounds: boundsOf(row?.afterMin, row?.afterMax),
    };
}

export async function queryInvoiceList(
    session: ReadModelSession,
    request: InvoiceListRequest,
): Promise<InvoiceListResult> {
    const base = baseRows(session, request.direction, request.today);
    const facets = await queryInvoiceFacets(session, request);
    const pageSize = Math.max(1, Math.floor(request.pageSize));
    const pageCount = Math.max(1, Math.ceil(facets.matchCount / pageSize));
    const page = Math.min(Math.max(1, Math.floor(request.page) || 1), pageCount);
    const result = await session.execute(sql<Row>`${base}
        SELECT ${ROW_COLUMNS} FROM invoice_rows
        WHERE ${filterPredicate(request.filters)}
        ${orderClause(request.sort)}
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `);
    return {
        rows: result.rows.map(toRow),
        matchCount: facets.matchCount,
        totalCount: facets.totalCount,
        page,
        pageSize,
        pageCount,
        parties: facets.parties,
        issuedDates: facets.issuedDates,
        dueDates: facets.dueDates,
        taxPointDates: facets.taxPointDates,
        beforeBounds: facets.beforeBounds,
        afterBounds: facets.afterBounds,
    };
}

/**
 * Totals and counters for the current selection. Kept separate from the list
 * query so ticking a checkbox (or dragging a slider) never re-scans the table.
 */
export async function queryInvoiceSelection(
    session: ReadModelSession,
    request: InvoiceSelectionRequest,
): Promise<InvoiceSelectionSummary> {
    const result = await session.execute(sql<Row>`${baseRows(session, request.direction, request.today)}
        SELECT currency,
            COALESCE(SUM(CASE WHEN beforeVat IS NOT NULL THEN 1 ELSE 0 END), 0) AS knownBefore,
            COALESCE(SUM(CASE WHEN afterVat IS NOT NULL THEN 1 ELSE 0 END), 0) AS knownAfter,
            COALESCE(SUM(beforeVat), 0) AS before,
            COALESCE(SUM(afterVat), 0) AS after,
            COUNT(*) AS rowCount,
            COALESCE(SUM(CASE WHEN beforeVat IS NULL THEN 1 ELSE 0 END), 0) AS missingBefore,
            COALESCE(SUM(CASE WHEN afterVat IS NULL THEN 1 ELSE 0 END), 0) AS missingAfter,
            COALESCE(SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END), 0) AS blocked,
            COALESCE(SUM(CASE WHEN status != 'paid' THEN 1 ELSE 0 END), 0) AS unpaid
        FROM invoice_rows
        WHERE ${selectionPredicate(request.scope)}
        GROUP BY currency ORDER BY currency
    `);
    const summary: InvoiceSelectionSummary = { count: 0, blocked: 0, unpaid: 0, totals: [] };
    for (const row of result.rows) {
        summary.count += Number(row.rowCount);
        summary.blocked += Number(row.blocked);
        summary.unpaid += Number(row.unpaid);
        summary.totals.push({
            currency: String(row.currency),
            before: Number(row.before),
            after: Number(row.after),
            knownBefore: Number(row.knownBefore),
            knownAfter: Number(row.knownAfter),
            missingBefore: Number(row.missingBefore),
            missingAfter: Number(row.missingAfter),
        });
    }
    return summary;
}

export interface InvoiceOverview {
    currency: string;
    outstanding: number;
    outstandingCount: number;
    overdue: number;
    overdueCount: number;
    /** Payable total of invoices issued since `periodStart`. */
    invoiced: number;
}

/**
 * Page summary for issued invoices, per currency: what is owed, what is late,
 * and what was invoiced this period. Statuses follow the list's derived status.
 */
export async function queryInvoiceOverview(
    session: ReadModelSession,
    request: { today: string; periodStart: string },
): Promise<InvoiceOverview[]> {
    const result = await session.execute(sql<Row>`${baseRows(session, 'issued', request.today)}
        SELECT currency,
            COALESCE(SUM(CASE WHEN status != 'paid' THEN afterVat ELSE 0 END), 0) AS outstanding,
            COALESCE(SUM(CASE WHEN status != 'paid' THEN 1 ELSE 0 END), 0) AS outstandingCount,
            COALESCE(SUM(CASE WHEN status = 'overdue' THEN afterVat ELSE 0 END), 0) AS overdue,
            COALESCE(SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END), 0) AS overdueCount,
            COALESCE(SUM(CASE WHEN SUBSTR(issued, 1, 10) >= ${request.periodStart} THEN afterVat ELSE 0 END), 0) AS invoiced
        FROM invoice_rows
        GROUP BY currency ORDER BY COUNT(*) DESC, currency
    `);
    return result.rows.map((row) => ({
        currency: String(row.currency),
        outstanding: Number(row.outstanding),
        outstandingCount: Number(row.outstandingCount),
        overdue: Number(row.overdue),
        overdueCount: Number(row.overdueCount),
        invoiced: Number(row.invoiced),
    }));
}

/**
 * The ids a selection resolves to, for actions that need whole records. The
 * scope (all matching / explicit ids / exclusions) is resolved in SQL so the
 * client never has to hold every row to act on them.
 */
export async function queryInvoiceSelectionIds(
    session: ReadModelSession,
    request: InvoiceSelectionRequest,
): Promise<string[]> {
    const result = await session.execute(sql<{ id: string }>`${baseRows(session, request.direction, request.today)}
        SELECT id FROM invoice_rows WHERE ${selectionPredicate(request.scope)} ORDER BY id
    `);
    return result.rows.map((row) => String(row.id));
}
