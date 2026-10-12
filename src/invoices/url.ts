import { goto } from "$app/navigation";
import { page } from "$app/state";
import { browser } from "$app/env";
import {
    DEFAULT_INVOICE_SORT,
    EMPTY_INVOICE_FILTERS,
    INVOICE_SORT_IDS,
    type InvoiceListFilters,
    type InvoiceSort,
} from "./list-contracts.js";

type InvoiceTab = "issued" | "received" | "analytics" | "parties";
type InvoiceView = "details" | "pdf";
type InvoiceBasis = "issue" | "taxPoint" | "due";
type InvoiceGranularity = "month" | "quarter" | "year";
export type InvoiceAnalyticsReport = "performance" | "vat" | "tax";

export interface InvoiceRouteState {
    tab: InvoiceTab;
    invoice: string | null;
    view: InvoiceView;
    /** Analytics-only filters; null means the dashboard default. */
    basis: InvoiceBasis | null;
    year: number | "all" | null;
    grain: InvoiceGranularity | null;
    /** Selected analytics report; null means Performance. */
    report: InvoiceAnalyticsReport | null;
    /** List filters; shared by the issued and received tabs. */
    filters: InvoiceListFilters;
    sort: InvoiceSort;
    /** 1-based page of the list. */
    page: number;
}

type InvoicePageState = App.PageState & { invoiceRoute?: InvoiceRouteState };

/** Every query parameter this route owns; anything else on the URL is left alone. */
const MANAGED_PARAMS = [
    "tab",
    "invoice",
    "view",
    "basis",
    "year",
    "grain",
    "report",
    "q",
    "num",
    "party",
    "status",
    "type",
    "issuedFrom",
    "issuedTo",
    "dueFrom",
    "dueTo",
    "duzpFrom",
    "duzpTo",
    "beforeMin",
    "beforeMax",
    "afterMin",
    "afterMax",
    "sort",
    "page",
] as const;

export function emptyInvoiceRouteState(): InvoiceRouteState {
    return {
        tab: "issued",
        invoice: null,
        view: "details",
        basis: null,
        year: null,
        grain: null,
        report: null,
        filters: { ...EMPTY_INVOICE_FILTERS, issued: { ...EMPTY_INVOICE_FILTERS.issued }, due: { ...EMPTY_INVOICE_FILTERS.due }, taxPoint: { ...EMPTY_INVOICE_FILTERS.taxPoint }, beforeVat: { ...EMPTY_INVOICE_FILTERS.beforeVat }, afterVat: { ...EMPTY_INVOICE_FILTERS.afterVat } },
        sort: { ...DEFAULT_INVOICE_SORT },
        page: 1,
    };
}

/**
 * A fresh, mutable copy of the address bar URL. Reading the address bar (not
 * only the router state) keeps selections stable when an invalidation replaces
 * shallow page state. `page.url` is the already-parsed fallback.
 */
function currentUrl(): URL {
    if (!browser) return new URL(page.url.href);
    try {
        return new URL(window.location.href);
    } catch {
        return new URL(page.url.href);
    }
}

function readParam(params: URLSearchParams, key: string): string {
    return params.get(key) ?? "";
}

function parseSort(raw: string): InvoiceSort {
    const [id, direction] = raw.split(":");
    if (!id || !(INVOICE_SORT_IDS as readonly string[]).includes(id)) return { ...DEFAULT_INVOICE_SORT };
    return { id, desc: direction !== "asc" };
}

function parsePage(raw: string): number {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : 1;
}

function parseFilters(params: URLSearchParams): InvoiceListFilters {
    const status = readParam(params, "status");
    return {
        search: readParam(params, "q"),
        invoiceNumber: readParam(params, "num"),
        party: readParam(params, "party"),
        status: status || "all",
        expenseType: readParam(params, "type"),
        issued: { from: readParam(params, "issuedFrom"), to: readParam(params, "issuedTo") },
        due: { from: readParam(params, "dueFrom"), to: readParam(params, "dueTo") },
        taxPoint: { from: readParam(params, "duzpFrom"), to: readParam(params, "duzpTo") },
        beforeVat: { min: readParam(params, "beforeMin"), max: readParam(params, "beforeMax") },
        afterVat: { min: readParam(params, "afterMin"), max: readParam(params, "afterMax") },
    };
}

/** Parses route state straight from a URL, ignoring shallow page state. */
export function parseInvoiceRouteState(url: URL): InvoiceRouteState {
    const params = url.searchParams;
    const tabParam = params.get("tab");
    const yearParam = params.get("year");
    const basisParam = params.get("basis");
    const grainParam = params.get("grain");
    const reportParam = params.get("report");

    const state = emptyInvoiceRouteState();

    if (tabParam === "received") state.tab = "received"; else if (tabParam === "analytics") state.tab = "analytics"; else if (tabParam === "parties") state.tab = "parties";
    if (basisParam === "duzp") state.basis = "taxPoint"; else if (basisParam === "due") state.basis = "due"; else if (basisParam === "issue") state.basis = "issue";
    if (yearParam === "all") state.year = "all"; else if (yearParam && (/^\d{4}$/).test(yearParam)) state.year = Number(yearParam);
    if (grainParam === "quarter" || grainParam === "year" || grainParam === "month") state.grain = grainParam;
    if (reportParam === "vat" || reportParam === "tax" || reportParam === "performance") state.report = reportParam;

    state.invoice = params.get("invoice");
    state.view = params.get("view") === "pdf" ? "pdf" : "details";
    state.filters = parseFilters(params);
    state.sort = parseSort(readParam(params, "sort"));
    state.page = parsePage(readParam(params, "page"));
    return state;
}

/**
 * Query parameters make selections linkable; page state makes shallow changes
 * reactive offline. A stored state is preferred for reactivity and merged onto
 * the defaults so a value written by an older version cannot leave a hole.
 */
export function invoiceRouteState(): InvoiceRouteState {
    const stored = (page.state as InvoicePageState).invoiceRoute;
    if (!stored) return parseInvoiceRouteState(currentUrl());
    const base = emptyInvoiceRouteState();
    return {
        ...base,
        ...stored,
        filters: {
            ...base.filters,
            ...stored.filters,
            issued: { ...base.filters.issued, ...stored.filters?.issued },
            due: { ...base.filters.due, ...stored.filters?.due },
            taxPoint: { ...base.filters.taxPoint, ...stored.filters?.taxPoint },
            beforeVat: { ...base.filters.beforeVat, ...stored.filters?.beforeVat },
            afterVat: { ...base.filters.afterVat, ...stored.filters?.afterVat },
        },
        sort: stored.sort?.id ? { ...stored.sort } : base.sort,
        page: Number.isInteger(stored.page) && stored.page > 0 ? stored.page : 1,
    };
}

/**
 * Route state straight from the address bar. Used to re-seed the list controls
 * when the browser moves through history, where no shallow state was stored.
 */
export function invoiceRouteFromUrl(): InvoiceRouteState {
    return parseInvoiceRouteState(currentUrl());
}

function setParam(url: URL, key: string, value: string | number | null | undefined): void {
    const text = value === null || value === undefined ? "" : String(value);
    if (text) url.searchParams.set(key, text);
    else url.searchParams.delete(key);
}

function writeFilters(url: URL, state: InvoiceRouteState): void {
    const { filters } = state;
    setParam(url, "q", filters.search);
    setParam(url, "num", filters.invoiceNumber);
    setParam(url, "party", filters.party);
    if (filters.status && filters.status !== "all") setParam(url, "status", filters.status);
    setParam(url, "type", filters.expenseType);
    setParam(url, "issuedFrom", filters.issued.from);
    setParam(url, "issuedTo", filters.issued.to);
    setParam(url, "dueFrom", filters.due.from);
    setParam(url, "dueTo", filters.due.to);
    setParam(url, "duzpFrom", filters.taxPoint.from);
    setParam(url, "duzpTo", filters.taxPoint.to);
    setParam(url, "beforeMin", filters.beforeVat.min);
    setParam(url, "beforeMax", filters.beforeVat.max);
    setParam(url, "afterMin", filters.afterVat.min);
    setParam(url, "afterMax", filters.afterVat.max);
    if (state.sort.id !== DEFAULT_INVOICE_SORT.id || state.sort.desc !== DEFAULT_INVOICE_SORT.desc) {
        setParam(url, "sort", `${state.sort.id}:${state.sort.desc ? "desc" : "asc"}`);
    }
    if (state.page > 1) setParam(url, "page", state.page);
}

/**
 * A mutable copy of a URL. Falls back to the original when it cannot be
 * re-parsed, which keeps a malformed address bar from breaking navigation.
 */
function cloneUrl(url: URL): URL {
    try {
        return new URL(url.href);
    } catch {
        return url;
    }
}

/**
 * Builds the URL for a route state. Only managed parameters are touched, so
 * unrelated query values survive, and defaults are dropped to keep links short.
 */
function buildUrl(base: URL, next: InvoiceRouteState): string {
    const url = cloneUrl(base);
    for (const key of MANAGED_PARAMS) url.searchParams.delete(key);

    if (next.tab === "received") url.searchParams.set("tab", "received");
    else if (next.tab === "analytics") url.searchParams.set("tab", "analytics");
    else if (next.tab === "parties") url.searchParams.set("tab", "parties");

    if (next.invoice) {
        url.searchParams.set("invoice", next.invoice);
        if (next.view === "pdf") url.searchParams.set("view", "pdf");
    }

    if (next.tab === "analytics") {
        if (next.basis === "due") url.searchParams.set("basis", "due");
        else if (next.basis === "taxPoint") url.searchParams.set("basis", "duzp");
        else if (next.basis === "issue") url.searchParams.set("basis", "issue");
        if (next.year === "all") url.searchParams.set("year", "all");
        else if (typeof next.year === "number") url.searchParams.set("year", String(next.year));
        if (next.grain) url.searchParams.set("grain", next.grain);
        if (next.report && next.report !== "performance") url.searchParams.set("report", next.report);
    } else if (next.tab !== "parties") {
        writeFilters(url, next);
    }

    return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * A structured-cloneable copy of the route state. History entries cannot hold
 * Svelte reactive proxies, and the list controls hand their own `$state`
 * straight in, so every value is copied out to a primitive here.
 */
function plainRouteState(state: InvoiceRouteState): InvoiceRouteState {
    return {
        tab: state.tab,
        invoice: state.invoice,
        view: state.view,
        basis: state.basis,
        year: state.year,
        grain: state.grain,
        report: state.report,
        filters: {
            search: state.filters.search,
            invoiceNumber: state.filters.invoiceNumber,
            party: state.filters.party,
            status: state.filters.status,
            expenseType: state.filters.expenseType,
            issued: { from: state.filters.issued.from, to: state.filters.issued.to },
            due: { from: state.filters.due.from, to: state.filters.due.to },
            taxPoint: { from: state.filters.taxPoint.from, to: state.filters.taxPoint.to },
            beforeVat: { min: state.filters.beforeVat.min, max: state.filters.beforeVat.max },
            afterVat: { min: state.filters.afterVat.min, max: state.filters.afterVat.max },
        },
        sort: { id: state.sort.id, desc: state.sort.desc },
        page: state.page,
    };
}

function commit(next: InvoiceRouteState, history: "push" | "replace"): void {
    const url = buildUrl(currentUrl(), next);
    const state: InvoicePageState = { ...page.state, invoiceRoute: plainRouteState(next) };

    if (history === "push") goto(url, { shallow: true, state }); else goto(url, { shallow: true, replace: true, state });
}

export function navigateInvoices(
    updates: Partial<InvoiceRouteState>,
    history: "push" | "replace" = "replace",
): void {
    const current = invoiceRouteState();
    const next: InvoiceRouteState = { ...current, ...updates };
    if (updates.tab !== undefined && updates.tab !== current.tab) {
        // Each direction has its own rows: a filter or a page number from the
        // other tab would name columns the next list does not have.
        next.filters = updates.filters ?? emptyInvoiceRouteState().filters;
        next.sort = updates.sort ?? { ...DEFAULT_INVOICE_SORT };
        next.page = updates.page ?? 1;
    }
    commit(next, history);
}

/**
 * Mirrors the list controls into the URL without disturbing the drawer, the
 * analytics view or the open tab. A no-op when the URL already describes this
 * state, which keeps it safe to call from an effect.
 */
export function syncInvoiceListRoute(
    list: { filters: InvoiceListFilters; sort: InvoiceSort; page: number },
): void {
    const base = currentUrl();
    const next: InvoiceRouteState = { ...invoiceRouteState(), ...list };
    if (buildUrl(base, next) === `${base.pathname}${base.search}${base.hash}`) return;
    commit(next, "replace");
}
