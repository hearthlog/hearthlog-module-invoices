/**
 * The invoice list contracts, shared by the SQL query, the URL state and the
 * components. Kept apart from the TanStack wiring in `list-table.ts` so the data
 * layer never has to import a UI library just to describe a query.
 */

/**
 * One row of the invoice list, projected by the SQL list query. Every semantic
 * value - party, amounts, status, currency - is derived there and rendered
 * verbatim, so filtering, sorting and display can never disagree. Presentation
 * (money, date and storage-label wording) stays in components.
 */
export interface InvoiceListRow {
    id: string;
    invoiceNumber: string;
    party: string;
    issued: string;
    due: string;
    /** The tax point (DUZP) as a day, or '' when the document has none. */
    taxPoint: string;
    beforeVat: number | null;
    afterVat: number | null;
    currency: string;
    /** `review` | `paid` | `unpaid` (received) / `overdue` resolved in SQL. */
    status: string;
    /** `draft` | `issued`, or null when `document_state` is unusable. */
    documentState: 'draft' | 'issued' | null;
    /** The stored original's upload status, or null when there is nothing to report. */
    storageStatus: string | null;
    /** A received invoice's expense type, or '' when not set; always '' for issued invoices. */
    expenseType: string;
}

export interface DateRange {
    from: string;
    to: string;
}

export interface NumberRange {
    min: string;
    max: string;
}

/**
 * The list filters as the user set them, independent of where they are stored.
 * Serialized into the URL and handed to the SQL list query unchanged, so the
 * link, the controls and the query can never drift apart.
 */
export interface InvoiceListFilters {
    /** Free text matched against the invoice number or the party name. */
    search: string;
    invoiceNumber: string;
    party: string;
    status: string;
    /** An expense type value, `unset` for received invoices without one, or '' for any. */
    expenseType: string;
    issued: DateRange;
    due: DateRange;
    /** The DUZP range; a document without a tax point never matches it. */
    taxPoint: DateRange;
    beforeVat: NumberRange;
    afterVat: NumberRange;
}

export interface InvoiceSort {
    id: string;
    desc: boolean;
}

export const DEFAULT_INVOICE_SORT: InvoiceSort = { id: 'issued', desc: true };

export const EMPTY_INVOICE_FILTERS: InvoiceListFilters = {
    search: '',
    invoiceNumber: '',
    party: '',
    status: 'all',
    expenseType: '',
    issued: { from: '', to: '' },
    due: { from: '', to: '' },
    taxPoint: { from: '', to: '' },
    beforeVat: { min: '', max: '' },
    afterVat: { min: '', max: '' },
};

export const INVOICE_SORT_IDS = [
    'invoiceNumber',
    'party',
    'issued',
    'due',
    'beforeVat',
    'afterVat',
    'status',
] as const;

/**
 * A resolved selection handed to the page for a bulk action. `ids: null` means
 * "every row matching `filters`", so acting on a filtered set never requires
 * the client to have loaded it.
 */
export interface InvoiceSelection {
    ids: string[] | null;
    filters: InvoiceListFilters;
    excludedIds: string[];
    /** Rows of the current page, for confirmation copy. */
    rows: InvoiceListRow[];
    count: number;
    pageRows: number;
}

/** The `expenseType` filter value that matches received invoices without a type. */
export const EXPENSE_TYPE_UNSET = 'unset';

/** True when any list filter is narrowing the result set. */
export function hasInvoiceListFilters(filters: InvoiceListFilters): boolean {
    return Boolean(
        filters.search.trim() ||
        filters.invoiceNumber.trim() ||
        filters.party ||
        (filters.status && filters.status !== 'all') ||
        filters.expenseType ||
        filters.issued.from || filters.issued.to ||
        filters.due.from || filters.due.to ||
        filters.taxPoint.from || filters.taxPoint.to ||
        filters.beforeVat.min || filters.beforeVat.max ||
        filters.afterVat.min || filters.afterVat.max,
    );
}

/** A fresh, independently mutable set of empty filters. */
export function emptyInvoiceFilters(): InvoiceListFilters {
    return {
        ...EMPTY_INVOICE_FILTERS,
        issued: { ...EMPTY_INVOICE_FILTERS.issued },
        due: { ...EMPTY_INVOICE_FILTERS.due },
        taxPoint: { ...EMPTY_INVOICE_FILTERS.taxPoint },
        beforeVat: { ...EMPTY_INVOICE_FILTERS.beforeVat },
        afterVat: { ...EMPTY_INVOICE_FILTERS.afterVat },
    };
}
