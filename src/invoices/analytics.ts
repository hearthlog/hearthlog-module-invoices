/**
 * Read-only invoice analytics for the tax dashboard.
 *
 * Everything is derived in memory from the invoices the page already loads, so
 * the dashboard also works offline. All amounts are CZK;
 * documents in other currencies are counted as exclusions instead of being
 * converted with an invented rate.
 */

import { format } from "date-fns";
import {
    summarizeAnnualEarnings,
    taxConfig,
    type AnnualTaxSummary,
    type TaxConfig,
} from "@hearthlog/czech";
import type { Invoice, ReceivedInvoice } from "../data/invoices.js";
import { invoiceTotalPayable } from "./amount.js";
import { roundHalfUp } from "./extraction/decimal.js";
import { receivedBreakdown } from "./received-document.js";

/** Which invoice date groups a document into a month, quarter or year. */
export type AnalyticsBasis = "issue" | "taxPoint" | "due";
/** How the selected period is split on the x axis. */
export type AnalyticsGranularity = "month" | "quarter" | "year";
/** `all` spans every year present in the data. */
export type AnalyticsYear = number | "all";

export interface AnalyticsRow {
    id: string;
    /** Effective day (YYYY-MM-DD) the document belongs to for the selected basis. */
    day: string;
    /**
     * Assumed payment day used by the annual tax estimate: the recorded paid
     * date when one exists, otherwise the due date, otherwise the issue date.
     * Issued invoices do not store a paid date yet, so their due date is the
     * best available estimate of when the money arrives.
     */
    paidDay: string;
    /** Amount before VAT. */
    net: number;
    /** VAT amount. */
    vat: number;
    /** Amount including VAT. */
    gross: number;
}

export interface AnalyticsExclusions {
    issuedDrafts: number;
    issuedWithoutDate: number;
    receivedInReview: number;
    receivedWithoutDate: number;
    receivedForeignCurrency: number;
    /** Documents counted in a period through the issue-date fallback. */
    missingTaxPoint: number;
    /** Documents without a due date counted through the issue-date fallback. */
    missingDueDate: number;
}

export interface AnalyticsDataset {
    issued: AnalyticsRow[];
    received: AnalyticsRow[];
    exclusions: AnalyticsExclusions;
}

export interface AnalyticsBucketTotals {
    key: string;
    label: string;
    issuedNet: number;
    issuedVat: number;
    issuedGross: number;
    issuedCount: number;
    receivedNet: number;
    receivedVat: number;
    receivedGross: number;
    receivedCount: number;
    /** issuedNet - receivedNet. */
    profit: number;
    /** issuedVat - receivedVat; negative means a VAT credit. */
    vatDue: number;
}

export interface YearlyTax {
    year: number;
    /** Issued revenue before VAT, the income the flat-rate estimate uses. */
    revenue: number;
    /** Received costs before VAT, shown as context only. */
    costs: number;
    issuedCount: number;
    receivedCount: number;
    tax: AnnualTaxSummary;
}

const emptyTotals = () => ({
    issuedNet: 0,
    issuedVat: 0,
    issuedGross: 0,
    issuedCount: 0,
    receivedNet: 0,
    receivedVat: 0,
    receivedGross: 0,
    receivedCount: 0,
});

/** Parses an ISO date or datetime and returns a validated YYYY-MM-DD day. */
export function normalizeDay(value: string | null | undefined): string | null {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) return null;
    const day = `${match[1]}-${match[2]}-${match[3]}`;
    const parsed = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return null;
    // Rejects overflowing days such as 2026-02-31.
    return parsed.toISOString().slice(0, 10) === day ? day : null;
}

function isCzk(currency: string | null | undefined): boolean {
    const value = (currency ?? "").trim().toUpperCase();
    return value === "" || value === "CZK";
}

/**
 * Effective period day. The DUZP basis falls back to the issue date because
 * an invoice without a tax point still belongs to a reporting period; the due
 * basis does the same for a document that has no due date yet.
 */
function effectiveDay(
    issueDate: string | null | undefined,
    taxPointDate: string | null | undefined,
    dueDate: string | null | undefined,
    basis: AnalyticsBasis,
    exclusions: AnalyticsExclusions,
): string | null {
    const issueDay = normalizeDay(issueDate);
    if (basis === "issue") {
        if (!issueDay) exclusions.issuedWithoutDate += 1;
        return issueDay;
    }
    if (basis === "due") {
        const dueDay = normalizeDay(dueDate);
        if (dueDay) return dueDay;
        if (issueDay) exclusions.missingDueDate += 1;
        else exclusions.issuedWithoutDate += 1;
        return issueDay;
    }
    const taxPointDay = normalizeDay(taxPointDate);
    if (taxPointDay) return taxPointDay;
    if (issueDay) exclusions.missingTaxPoint += 1;
    else exclusions.issuedWithoutDate += 1;
    return issueDay;
}

function receivedEffectiveDay(
    issueDate: string | null | undefined,
    taxPointDate: string | null | undefined,
    dueDate: string | null | undefined,
    basis: AnalyticsBasis,
    exclusions: AnalyticsExclusions,
): string | null {
    const issueDay = normalizeDay(issueDate);
    if (basis === "issue") {
        if (!issueDay) exclusions.receivedWithoutDate += 1;
        return issueDay;
    }
    if (basis === "due") {
        const dueDay = normalizeDay(dueDate);
        if (dueDay) return dueDay;
        if (issueDay) exclusions.missingDueDate += 1;
        else exclusions.receivedWithoutDate += 1;
        return issueDay;
    }
    const taxPointDay = normalizeDay(taxPointDate);
    if (taxPointDay) return taxPointDay;
    if (issueDay) exclusions.missingTaxPoint += 1;
    else exclusions.receivedWithoutDate += 1;
    return issueDay;
}

/**
 * Builds the analytics rows for both directions.
 *
 * Issued drafts never count as income. Received invoices still in review are
 * incomplete documents and are excluded until they are reviewed. Only CZK
 * documents are summed; the rest are reported as exclusions.
 */
export function buildAnalyticsDataset(
    invoices: Invoice[],
    receivedInvoices: ReceivedInvoice[],
    basis: AnalyticsBasis,
): AnalyticsDataset {
    const exclusions: AnalyticsExclusions = {
        issuedDrafts: 0,
        issuedWithoutDate: 0,
        receivedInReview: 0,
        receivedWithoutDate: 0,
        receivedForeignCurrency: 0,
        missingTaxPoint: 0,
        missingDueDate: 0,
    };
    const issued: AnalyticsRow[] = [];
    for (const invoice of invoices) {
        if (invoice.status === "draft") {
            exclusions.issuedDrafts += 1;
            continue;
        }
        const day = effectiveDay(
            invoice.issue_date,
            invoice.tax_point_date,
            invoice.due_date,
            basis,
            exclusions,
        );
        if (!day) continue;
        const net = roundHalfUp(invoice.amount, 2);
        const gross = roundHalfUp(invoiceTotalPayable(invoice), 2);
        issued.push({
            id: invoice.id,
            day,
            paidDay:
                normalizeDay(invoice.due_date) ??
                normalizeDay(invoice.issue_date) ??
                day,
            net,
            vat: Math.max(0, roundHalfUp(gross - net, 2)),
            gross,
        });
    }

    const received: AnalyticsRow[] = [];
    for (const invoice of receivedInvoices) {
        if (invoice.status === "review") {
            exclusions.receivedInReview += 1;
            continue;
        }
        if (!isCzk(invoice.currency)) {
            exclusions.receivedForeignCurrency += 1;
            continue;
        }
        const day = receivedEffectiveDay(
            invoice.issue_date,
            invoice.tax_point_date,
            invoice.due_date,
            basis,
            exclusions,
        );
        if (!day) continue;
        const breakdown = receivedBreakdown(invoice);
        received.push({
            id: invoice.id,
            day,
            // A recorded payment is the real event; otherwise the due date
            // estimates it until issued invoices store a paid date too.
            paidDay:
                normalizeDay(invoice.paid_at) ??
                normalizeDay(invoice.due_date) ??
                normalizeDay(invoice.issue_date) ??
                day,
            net: roundHalfUp(breakdown.subtotal, 2),
            vat: roundHalfUp(breakdown.vatTotal, 2),
            gross: roundHalfUp(breakdown.total, 2),
        });
    }

    return { issued, received, exclusions };
}

/** The bucket key a day belongs to for the given granularity. */
export function bucketKey(
    day: string,
    granularity: AnalyticsGranularity,
): string {
    const year = day.slice(0, 4);
    if (granularity === "year") return year;
    const month = Number(day.slice(5, 7));
    if (granularity === "quarter") return `${year}-Q${Math.ceil(month / 3)}`;
    return `${year}-${day.slice(5, 7)}`;
}

/** The inclusive first and last day of a bucket, as ISO days. */
export interface BucketRange {
    from: string;
    to: string;
}

function lastDayOfMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Expands a bucket key back into the date range it covers, so a chart column
 * can open the invoice list filtered to exactly the days it aggregates. Returns
 * null for a malformed key instead of inventing a range.
 */
export function bucketRange(
    key: string,
    granularity: AnalyticsGranularity,
): BucketRange | null {
    if (granularity === "year") {
        if (!/^\d{4}$/.test(key)) return null;
        return { from: `${key}-01-01`, to: `${key}-12-31` };
    }
    const match = /^(\d{4})-(\d{2}|Q[1-4])$/.exec(key);
    if (!match) return null;
    const year = match[1]!;
    const part = match[2]!;
    if (granularity === "quarter") {
        if (!/^Q[1-4]$/.test(part)) return null;
        const startMonth = (Number(part.slice(1)) - 1) * 3 + 1;
        const endMonth = startMonth + 2;
        const asMonth = (month: number) => String(month).padStart(2, "0");
        return {
            from: `${year}-${asMonth(startMonth)}-01`,
            to: `${year}-${asMonth(endMonth)}-${lastDayOfMonth(Number(year), endMonth)}`,
        };
    }
    if (!/^\d{2}$/.test(part)) return null;
    const month = Number(part);
    if (month < 1 || month > 12) return null;
    return {
        from: `${year}-${part}-01`,
        to: `${year}-${part}-${lastDayOfMonth(Number(year), month)}`,
    };
}

function bucketLabel(
    year: number,
    granularity: AnalyticsGranularity,
    index: number,
): string {
    if (granularity === "year") return String(year);
    if (granularity === "quarter") return `Q${index + 1} ${year}`;
    return format(new Date(year, index, 1), "LLL yyyy");
}

/**
 * Lists the buckets the dashboard renders. A selected year always yields the
 * full 12 months / 4 quarters, including empty ones, so a quiet month is
 * visible as a zero instead of disappearing from the chart.
 */
export function listBucketKeys(
    granularity: AnalyticsGranularity,
    year: AnalyticsYear,
    years: number[],
): Array<{ key: string; label: string }> {
    const targetYears = year === "all" ? years : [year];
    const buckets: Array<{ key: string; label: string }> = [];
    for (const target of targetYears) {
        if (granularity === "year") {
            buckets.push({ key: String(target), label: String(target) });
            continue;
        }
        const count = granularity === "quarter" ? 4 : 12;
        for (let index = 0; index < count; index += 1) {
            buckets.push({
                key:
                    granularity === "quarter"
                        ? `${target}-Q${index + 1}`
                        : `${target}-${String(index + 1).padStart(2, "0")}`,
                label: bucketLabel(target, granularity, index),
            });
        }
    }
    return buckets;
}

/** Years that contain at least one analytics row, ascending. */
export function yearsWithData(dataset: AnalyticsDataset): number[] {
    const years = new Set<number>();
    for (const row of [...dataset.issued, ...dataset.received]) {
        years.add(Number(row.day.slice(0, 4)));
    }
    return [...years].sort((left, right) => left - right);
}

function finalize(
    bucket: { key: string; label: string } & ReturnType<typeof emptyTotals>,
): AnalyticsBucketTotals {
    return {
        ...bucket,
        issuedNet: roundHalfUp(bucket.issuedNet, 2),
        issuedVat: roundHalfUp(bucket.issuedVat, 2),
        issuedGross: roundHalfUp(bucket.issuedGross, 2),
        receivedNet: roundHalfUp(bucket.receivedNet, 2),
        receivedVat: roundHalfUp(bucket.receivedVat, 2),
        receivedGross: roundHalfUp(bucket.receivedGross, 2),
        profit: roundHalfUp(bucket.issuedNet - bucket.receivedNet, 2),
        vatDue: roundHalfUp(bucket.issuedVat - bucket.receivedVat, 2),
    };
}

/** Aggregates both directions into the period buckets for the chart/table. */
export function buildAnalyticsBuckets(
    dataset: AnalyticsDataset,
    granularity: AnalyticsGranularity,
    year: AnalyticsYear,
): AnalyticsBucketTotals[] {
    const years = yearsWithData(dataset);
    const buckets = listBucketKeys(granularity, year, years).map((bucket) => ({
        ...bucket,
        ...emptyTotals(),
    }));
    const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));

    for (const row of dataset.issued) {
        const bucket = byKey.get(bucketKey(row.day, granularity));
        if (!bucket) continue;
        bucket.issuedNet += row.net;
        bucket.issuedVat += row.vat;
        bucket.issuedGross += row.gross;
        bucket.issuedCount += 1;
    }
    for (const row of dataset.received) {
        const bucket = byKey.get(bucketKey(row.day, granularity));
        if (!bucket) continue;
        bucket.receivedNet += row.net;
        bucket.receivedVat += row.vat;
        bucket.receivedGross += row.gross;
        bucket.receivedCount += 1;
    }

    return buckets.map(finalize);
}

export interface AnalyticsTotals extends ReturnType<typeof emptyTotals> {
    profit: number;
    vatDue: number;
}

/** Sums the visible buckets into the KPI totals above the charts. */
export function summarizeBuckets(
    buckets: AnalyticsBucketTotals[],
): AnalyticsTotals {
    const totals = buckets.reduce((sum, bucket) => {
        sum.issuedNet += bucket.issuedNet;
        sum.issuedVat += bucket.issuedVat;
        sum.issuedGross += bucket.issuedGross;
        sum.issuedCount += bucket.issuedCount;
        sum.receivedNet += bucket.receivedNet;
        sum.receivedVat += bucket.receivedVat;
        sum.receivedGross += bucket.receivedGross;
        sum.receivedCount += bucket.receivedCount;
        return sum;
    }, emptyTotals());
    return {
        ...totals,
        issuedNet: roundHalfUp(totals.issuedNet, 2),
        issuedVat: roundHalfUp(totals.issuedVat, 2),
        issuedGross: roundHalfUp(totals.issuedGross, 2),
        receivedNet: roundHalfUp(totals.receivedNet, 2),
        receivedVat: roundHalfUp(totals.receivedVat, 2),
        receivedGross: roundHalfUp(totals.receivedGross, 2),
        profit: roundHalfUp(totals.issuedNet - totals.receivedNet, 2),
        vatDue: roundHalfUp(totals.issuedVat - totals.receivedVat, 2),
    };
}

export interface VatQuarterTotals {
    /** VAT on issued invoices, the output side. */
    issuedVat: number;
    /** VAT on reviewed CZK received invoices, the input side. */
    receivedVat: number;
    /** issuedVat - receivedVat; negative is a credit. */
    vatDue: number;
    issuedCount: number;
    receivedCount: number;
}

export interface VatQuarter extends VatQuarterTotals {
    /** `YYYY-Qn`, the sort key. */
    key: string;
    /** `Qn YYYY`, for the chart and table. */
    label: string;
}

export interface VatExclusions {
    /** Otherwise eligible documents without a usable DUZP. */
    issuedWithoutDuzp: number;
    receivedWithoutDuzp: number;
}

export interface VatReport {
    /** Quarters in ascending order; a shown year always has all four. */
    quarters: VatQuarter[];
    /** Sum of the shown quarters. */
    totals: VatQuarterTotals;
    /** DUZP years in the report, ascending. */
    years: number[];
    exclusions: VatExclusions;
}

function emptyVatTotals(): VatQuarterTotals {
    return {
        issuedVat: 0,
        receivedVat: 0,
        vatDue: 0,
        issuedCount: 0,
        receivedCount: 0,
    };
}

function finalizeVatTotals(row: VatQuarterTotals): VatQuarterTotals {
    return {
        issuedVat: roundHalfUp(row.issuedVat, 2),
        receivedVat: roundHalfUp(row.receivedVat, 2),
        vatDue: roundHalfUp(row.issuedVat - row.receivedVat, 2),
        issuedCount: row.issuedCount,
        receivedCount: row.receivedCount,
    };
}

function vatQuarterKey(day: string): string {
    return `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
}

/**
 * Years with at least one VAT-relevant document, ascending: a non-draft
 * issued invoice or a reviewed CZK received invoice with a valid DUZP.
 */
export function vatYearsWithData(
    invoices: Invoice[],
    receivedInvoices: ReceivedInvoice[],
): number[] {
    const years = new Set<number>();
    for (const invoice of invoices) {
        if (invoice.status === "draft") continue;
        const day = normalizeDay(invoice.tax_point_date);
        if (day) years.add(Number(day.slice(0, 4)));
    }
    for (const invoice of receivedInvoices) {
        if (invoice.status === "review" || !isCzk(invoice.currency)) continue;
        const day = normalizeDay(invoice.tax_point_date);
        if (day) years.add(Number(day.slice(0, 4)));
    }
    return [...years].sort((left, right) => left - right);
}

/**
 * VAT report grouped by the tax point date (DUZP) in calendar quarters.
 *
 * Only documents with a valid DUZP are counted: a VAT return cannot place a
 * document without a tax point in a period, so those are reported as
 * exclusions instead of falling back to the issue date. Output VAT (issued)
 * minus input VAT (received) is the amount due; a negative value is a credit.
 * The statutory period always comes from the DUZP, independently of the
 * dashboard's date basis.
 */
export function buildVatReport(
    invoices: Invoice[],
    receivedInvoices: ReceivedInvoice[],
    year: AnalyticsYear,
): VatReport {
    const exclusions: VatExclusions = {
        issuedWithoutDuzp: 0,
        receivedWithoutDuzp: 0,
    };
    const allYears = vatYearsWithData(invoices, receivedInvoices);
    const targetYears =
        year === "all"
            ? allYears
            : allYears.filter((candidate) => candidate === year);
    const byKey = new Map<string, VatQuarterTotals>();

    function rowFor(day: string): VatQuarterTotals {
        const key = vatQuarterKey(day);
        let row = byKey.get(key);
        if (!row) {
            row = emptyVatTotals();
            byKey.set(key, row);
        }
        return row;
    }

    for (const invoice of invoices) {
        if (invoice.status === "draft") continue;
        const day = normalizeDay(invoice.tax_point_date);
        if (!day) {
            exclusions.issuedWithoutDuzp += 1;
            continue;
        }
        if (!targetYears.includes(Number(day.slice(0, 4)))) continue;
        const gross = roundHalfUp(invoiceTotalPayable(invoice), 2);
        const net = roundHalfUp(invoice.amount, 2);
        const row = rowFor(day);
        row.issuedVat = roundHalfUp(
            row.issuedVat + Math.max(0, roundHalfUp(gross - net, 2)),
            2,
        );
        row.issuedCount += 1;
    }

    for (const invoice of receivedInvoices) {
        if (invoice.status === "review" || !isCzk(invoice.currency)) continue;
        const day = normalizeDay(invoice.tax_point_date);
        if (!day) {
            exclusions.receivedWithoutDuzp += 1;
            continue;
        }
        if (!targetYears.includes(Number(day.slice(0, 4)))) continue;
        const breakdown = receivedBreakdown(invoice);
        const row = rowFor(day);
        row.receivedVat = roundHalfUp(
            row.receivedVat + roundHalfUp(breakdown.vatTotal, 2),
            2,
        );
        row.receivedCount += 1;
    }

    const quarters: VatQuarter[] = [];
    for (const target of targetYears) {
        for (let quarter = 1; quarter <= 4; quarter += 1) {
            const key = `${target}-Q${quarter}`;
            const totals = finalizeVatTotals(byKey.get(key) ?? emptyVatTotals());
            quarters.push({ key, label: `Q${quarter} ${target}`, ...totals });
        }
    }

    const totals = finalizeVatTotals(
        quarters.reduce((sum, row) => {
            sum.issuedVat += row.issuedVat;
            sum.receivedVat += row.receivedVat;
            sum.issuedCount += row.issuedCount;
            sum.receivedCount += row.receivedCount;
            return sum;
        }, emptyVatTotals()),
    );

    return { quarters, totals, years: targetYears, exclusions };
}

/**
 * Annual flat-rate tax estimate per year. The calculator's formula is annual,
 * so the discount and tariff cap apply once per year over the year's issued
 * revenue; received costs are carried along as context, not subtracted.
 *
 * Years are the assumed payment days, not the chart's date basis: income tax
 * follows when money actually moves, so the estimate does not change when the
 * dashboard is regrouped by issue date or tax point.
 */
export function buildYearlyTax(
    dataset: AnalyticsDataset,
    config: TaxConfig = taxConfig,
): YearlyTax[] {
    const years = new Set<number>();
    for (const row of [...dataset.issued, ...dataset.received]) {
        years.add(Number(row.paidDay.slice(0, 4)));
    }

    return [...years]
        .sort((left, right) => left - right)
        .map((year) => {
            let revenue = 0;
            let costs = 0;
            let issuedCount = 0;
            let receivedCount = 0;
            for (const row of dataset.issued) {
                if (Number(row.paidDay.slice(0, 4)) !== year) continue;
                revenue += row.net;
                issuedCount += 1;
            }
            for (const row of dataset.received) {
                if (Number(row.paidDay.slice(0, 4)) !== year) continue;
                costs += row.net;
                receivedCount += 1;
            }
            const roundedRevenue = roundHalfUp(revenue, 2);
            return {
                year,
                revenue: roundedRevenue,
                costs: roundHalfUp(costs, 2),
                issuedCount,
                receivedCount,
                tax: summarizeAnnualEarnings(roundedRevenue, config),
            };
        });
}
