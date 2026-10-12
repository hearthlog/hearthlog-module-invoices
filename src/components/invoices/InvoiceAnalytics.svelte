<script lang="ts">
    import { Tabs } from 'bits-ui';
    import IconChartLine from '~icons/mdi/chart-line';
    import { EmptyState } from "@hearthlog/sdk/ui";
    import { DataPlaceholder } from "@hearthlog/sdk/ui";
    import { Select } from "@hearthlog/sdk/ui";
    import { tabIndicator } from '@hearthlog/sdk/ui';
    import InvoiceColumnChart, { type ColumnChartSeries } from './InvoiceColumnChart.svelte';
    import type { Invoice, ReceivedInvoice } from '../../data/invoices.js';
    import { formatInvoiceAmount, formatInvoiceDate } from '../../invoices/format.js';
    import { invoiceRouteState, navigateInvoices } from '../../invoices/url.js';
    import { emptyInvoiceFilters } from '../../invoices/list-contracts.js';
    import { invoiceToday } from '../../invoices/filters.js';
    import { taxConfig } from '@hearthlog/czech';
    import { appClock } from '@hearthlog/sdk/runtime';
    import { Modal } from "@hearthlog/sdk/ui";
    import IconChevronDown from '~icons/mdi/chevron-down';
    import { queryDatabase } from '@hearthlog/sdk/data';
    import { nextIncomeTaxDeadline, nextVatDeadline, vatConfig } from '../../invoices/vat-config.js';
    import {
        bucketKey,
        bucketRange,
        buildAnalyticsBuckets,
        buildAnalyticsDataset,
        buildVatReport,
        buildYearlyTax,
        summarizeBuckets,
        vatYearsWithData,
        yearsWithData,
        type AnalyticsBasis,
        type AnalyticsGranularity,
        type BucketRange,
        type YearlyTax,
    } from '../../invoices/analytics.js';

    let {
        revision = 0,
        loading = false,
    }: {
        revision?: number;
        loading?: boolean;
    } = $props();

    // Analytics aggregates across every invoice, so it reads its own dataset
    // rather than making the list and drawer paths pay for a full scan.
    let invoices = $state<Invoice[]>([]);
    let receivedInvoices = $state<ReceivedInvoice[]>([]);
    let dataLoading = $state(true);
    let dataError = $state(false);

    $effect(() => {
        void revision;
        let cancelled = false;
        dataLoading = true;
        dataError = false;
        queryDatabase(async (repositories) => ({
            issued: await repositories.invoices.getInvoices(),
            received: await repositories.invoices.getReceivedInvoices(),
        }))
            .then((result) => {
                if (cancelled) return;
                invoices = result.issued;
                receivedInvoices = result.received;
            })
            .catch(() => {
                if (!cancelled) dataError = true;
            })
            .finally(() => {
                if (!cancelled) dataLoading = false;
            });
        return () => {
            cancelled = true;
        };
    });

    // --- Filters (kept in the URL so reloads and Back keep the view) ---
    const routeState = $derived(invoiceRouteState());
    const basis = $derived(routeState.basis ?? 'issue');
    const granularity = $derived(routeState.grain ?? 'month');

    /** Writes the analytics filters only; list selections stay untouched. */
    function updateView(updates: { basis?: AnalyticsBasis | null; year?: number | 'all' | null; grain?: AnalyticsGranularity | null; report?: AnalyticsSection | null }): void {
        navigateInvoices(updates);
    }

    const dataset = $derived(buildAnalyticsDataset(invoices, receivedInvoices, basis));
    const dataYears = $derived(yearsWithData(dataset));
    const now = $derived(appClock.now());
    const today = $derived(invoiceToday(now));
    const currentYear = $derived(now.getFullYear());
    const selectedYear = $derived.by(() => {
        if (routeState.year !== null) return routeState.year;
        // Default to the current tax year when it has data, else the latest one.
        if (dataYears.includes(currentYear)) return currentYear;
        return dataYears.length ? dataYears[dataYears.length - 1]! : 'all';
    });

    const buckets = $derived(buildAnalyticsBuckets(dataset, granularity, selectedYear));
    const totals = $derived(summarizeBuckets(buckets));
    const yearlyTax = $derived(buildYearlyTax(dataset));
    // VAT is a statutory report: it always follows the DUZP and deliberately
    // ignores the dashboard's date basis, which only regroups the revenue view.
    const vatDataYears = $derived(vatYearsWithData(invoices, receivedInvoices));
    const vatReport = $derived(
        buildVatReport(invoices, receivedInvoices, selectedYear),
    );
    const hasAnalyticsData = $derived(dataset.issued.length > 0 || dataset.received.length > 0);

    // --- Year-over-year comparison -------------------------------------------
    // A part-finished year is compared through the current bucket only, so a
    // "vs 2025 YTD" chip never measures ten months against a full year.
    const previousYear = $derived(selectedYear === 'all' ? null : selectedYear - 1);
    const previousBuckets = $derived(
        previousYear === null ? [] : buildAnalyticsBuckets(dataset, granularity, previousYear),
    );
    const currentBucketKey = $derived(
        selectedYear !== 'all' && selectedYear === currentYear
            ? bucketKey(today, granularity)
            : null,
    );
    const currentBucketIndex = $derived(
        currentBucketKey === null
            ? -1
            : buckets.findIndex((bucket) => bucket.key === currentBucketKey),
    );
    let comparePrevious = $state(false);
    const comparison = $derived.by(() => {
        if (!comparePrevious || previousYear === null || !previousBuckets.length) return null;
        const elapsed = currentBucketIndex >= 0 ? currentBucketIndex + 1 : buckets.length;
        if (elapsed === 0) return null;
        return {
            label: selectedYear === currentYear ? `vs ${previousYear} YTD` : `vs ${previousYear}`,
            totals: summarizeBuckets(previousBuckets.slice(0, elapsed)),
        };
    });

    const emptyYear = (year: number): YearlyTax => ({
        year,
        revenue: 0,
        costs: 0,
        issuedCount: 0,
        receivedCount: 0,
        tax: { totalEarnings: 0, incomeTax: 0, socialInsurance: 0, medicalInsurance: 0, totalTaxes: 0, afterTaxEarnings: 0, effectiveRate: 0 },
    });

    /** Table rows: every year with data, plus the selected year when it is empty. */
    const taxRows = $derived.by(() => {
        const rows = [...yearlyTax];
        if (selectedYear !== 'all' && !rows.some((row) => row.year === selectedYear)) {
            rows.push(emptyYear(selectedYear));
        }
        return rows.sort((left, right) => right.year - left.year);
    });
    const taxChartRows = $derived([...taxRows].sort((left, right) => left.year - right.year));
    const highlightedTax: YearlyTax | null = $derived.by(() => {
        if (!taxChartRows.length) return null;
        if (selectedYear === 'all') return taxChartRows[taxChartRows.length - 1]!;
        return taxRows.find((row) => row.year === selectedYear) ?? null;
    });

    const yearOptions = $derived.by(() => {
        // DUZP years are offered too: a tax point may fall in a year with no
        // issue date, and the VAT report would otherwise be unreachable.
        const years = new Set<number>(dataYears);
        for (const year of vatDataYears) years.add(year);
        if (selectedYear !== 'all') years.add(selectedYear);
        return [
            { value: 'all', label: 'All years' },
            ...[...years].sort((left, right) => right - left).map((year) => ({ value: String(year), label: String(year) })),
        ];
    });

    function selectBasis(value: string): void {
        updateView({ basis: value as AnalyticsBasis });
    }
    function selectGranularity(value: string): void {
        updateView({ grain: value as AnalyticsGranularity });
    }
    function selectYear(value: string): void {
        if (value === 'all') {
            updateView({ year: 'all' });
            return;
        }
        const parsed = Number(value);
        updateView({ year: Number.isFinite(parsed) ? parsed : 'all' });
    }

    // --- Drill-through --------------------------------------------------------
    // Chart points inspect a period in place; explicit direction actions open
    // the list with the corresponding date range and basis.
    function openList(range: BucketRange | null, tab: 'issued' | 'received', target: 'issue' | 'due' | 'taxPoint'): void {
        if (!range) return;
        const filters = emptyInvoiceFilters();
        if (target === 'issue') filters.issued = range;
        else if (target === 'due') filters.due = range;
        else filters.taxPoint = range;
        navigateInvoices({ tab, filters });
    }
    function drillBucket(index: number): void {
        const bucket = buckets[index];
        if (!bucket) return;
        openList(
            bucketRange(bucket.key, granularity),
            'issued',
            basis === 'due' ? 'due' : basis === 'taxPoint' ? 'taxPoint' : 'issue',
        );
    }
    function onRevenuePoint(point: { seriesIndex: number; index: number }): void {
        if (point.seriesIndex > 1) return;
        const bucket = buckets[point.index];
        if (!bucket) return;
        inspectedKey = bucket.key;
    }
    let inspectedKey = $state<string | null>(null);
    const inspectedBucket = $derived(buckets.find((bucket) => bucket.key === inspectedKey)
        ?? buckets[currentBucketIndex] ?? buckets.at(-1) ?? null);
    function openInspected(direction: 'issued' | 'received'): void {
        if (inspectedBucket) openList(bucketRange(inspectedBucket.key, granularity), direction, basis);
    }
    function drillVatQuarter(index: number, direction: 'issued' | 'received'): void {
        const quarter = vatReport.quarters[index];
        if (!quarter) return;
        openList(bucketRange(quarter.key, 'quarter'), direction, 'taxPoint');
    }

    // --- Formatting ---
    const money = formatInvoiceAmount;
    const chartMoney = (value: number): string =>
        new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(value);
    const percent = (value: number): string =>
        new Intl.NumberFormat('cs-CZ', { style: 'percent', maximumFractionDigits: 1 }).format(value);

    const basisLabel = $derived(
        basis === 'issue'
            ? 'by issue date'
            : basis === 'taxPoint'
              ? 'by tax point (DUZP)'
              : 'by due date',
    );
    const granularityLabel = $derived(granularity === 'month' ? 'monthly' : granularity === 'quarter' ? 'quarterly' : 'yearly');
    const periodLabel = $derived(
        selectedYear === 'all' ? `${granularityLabel} · all years` : granularity === 'year' ? String(selectedYear) : `${granularityLabel} · ${selectedYear}`,
    );
    const scopeLabel = $derived(
        `Showing ${granularityLabel} periods · ${selectedYear === 'all' ? 'all years' : selectedYear} · grouped ${basisLabel}`,
    );

    const vatScopeLabel = $derived.by(() => {
        const years = vatReport.years;
        if (!years.length) {
            return selectedYear === 'all' ? 'all years' : String(selectedYear);
        }
        return years.length === 1
            ? String(years[0])
            : `${years[0]}–${years[years.length - 1]}`;
    });
    const vatTotalLabel = $derived(
        vatReport.years.length > 1 ? 'All years' : `${vatScopeLabel} total`,
    );
    const vatSeries = $derived<ColumnChartSeries[]>([
        {
            name: 'Output VAT',
            data: vatReport.quarters.map((row) => row.issuedVat),
            colorVar: '--stor-chart-issued',
        },
        {
            name: 'Input VAT',
            data: vatReport.quarters.map((row) => row.receivedVat),
            colorVar: '--stor-chart-received',
        },
    ]);
    const currentQuarterKey = $derived(`${currentYear}-Q${Math.ceil((now.getMonth() + 1) / 3)}`);
    const vatMarkerIndex = $derived(
        selectedYear === 'all' || selectedYear === currentYear
            ? vatReport.quarters.findIndex((row) => row.key === currentQuarterKey)
            : -1,
    );
    const vatExclusionNote = $derived.by(() => {
        const { issuedWithoutDuzp, receivedWithoutDuzp } = vatReport.exclusions;
        const total = issuedWithoutDuzp + receivedWithoutDuzp;
        if (!total) return '';
        const parts: string[] = [];
        if (issuedWithoutDuzp) parts.push(`${issuedWithoutDuzp} issued`);
        if (receivedWithoutDuzp) parts.push(`${receivedWithoutDuzp} received`);
        const noun = total === 1 ? 'document' : 'documents';
        const verb = total === 1 ? 'is' : 'are';
        return `${parts.join(' and ')} ${noun} without a valid tax point date (DUZP) ${verb} excluded from this report.`;
    });

    // --- Filing deadlines (hints, never advice) ------------------------------
    const vatDeadline = $derived(nextVatDeadline(now, vatConfig));
    const showVatDeadline = $derived(selectedYear === 'all' || selectedYear === currentYear);
    const incomeTaxDeadline = $derived(
        highlightedTax ? nextIncomeTaxDeadline(highlightedTax.year, vatConfig) : null,
    );
    const showIncomeTaxDeadline = $derived(
        incomeTaxDeadline !== null && incomeTaxDeadline >= today,
    );

    // --- KPI strip ------------------------------------------------------------
    interface KpiDelta {
        text: string;
        trend: 'up' | 'down';
        tone: 'positive' | 'negative' | 'neutral';
    }
    interface Kpi {
        label: string;
        value: string;
        detail: string;
        tone: string;
        delta: KpiDelta | null;
    }

    function deltaOf(
        current: number,
        previous: number | null | undefined,
        tone?: KpiDelta['tone'],
    ): KpiDelta | null {
        if (previous === null || previous === undefined || previous === 0) return null;
        const value = (current - previous) / Math.abs(previous);
        if (!Number.isFinite(value)) return null;
        return {
            text: percent(Math.abs(value)),
            trend: value >= 0 ? 'up' : 'down',
            tone: tone ?? (value >= 0 ? 'positive' : 'negative'),
        };
    }

    const kpis = $derived.by<Kpi[]>(() => {
        const margin = totals.issuedNet > 0 ? ` · margin ${percent(totals.profit / totals.issuedNet)}` : '';
        const previous = comparison?.totals ?? null;
        return [
            {
                label: 'Invoiced revenue',
                value: money(totals.issuedNet),
                detail: `${totals.issuedCount} issued invoice${totals.issuedCount === 1 ? '' : 's'} · before VAT`,
                tone: 'text-[var(--stor-ink)]',
                delta: deltaOf(totals.issuedNet, previous?.issuedNet),
            },
            {
                label: 'Invoice costs',
                value: money(totals.receivedNet),
                detail: `${totals.receivedCount} received invoice${totals.receivedCount === 1 ? '' : 's'} · before VAT`,
                tone: 'text-[var(--stor-ink)]',
                // More costs are not automatically bad, so the chip stays neutral.
                delta: deltaOf(totals.receivedNet, previous?.receivedNet, 'neutral'),
            },
            {
                label: 'Difference',
                value: money(totals.profit),
                detail: `Invoice revenue − invoice costs${margin}`,
                tone: totals.profit < 0 ? 'text-[var(--stor-negative)]' : totals.profit > 0 ? 'text-[var(--stor-positive)]' : 'text-[var(--stor-ink)]',
                delta: deltaOf(totals.profit, previous?.profit),
            },
        ];
    });

    // Issued and received never borrow the tenant accent: with a blue accent
    // both directions used to resolve to nearly the same hue. The chart tokens
    // are fixed per mode and checked for separation by the theme tests.
    const revenueSeries = $derived<ColumnChartSeries[]>([
        { name: 'Revenue (net)', data: buckets.map((bucket) => bucket.issuedNet), colorVar: '--stor-chart-issued' },
        { name: 'Costs (net)', data: buckets.map((bucket) => bucket.receivedNet), colorVar: '--stor-chart-received' },
        // The comparison lines come after the columns so the primary series
        // keep their palette indices.
        ...(comparison
            ? [
                {
                    name: `${previousYear} revenue`,
                    data: previousBuckets.map((bucket) => bucket.issuedNet),
                    colorVar: '--stor-chart-issued',
                    type: 'line' as const,
                    dashStyle: 'Dash' as const,
                    opacity: 0.45,
                },
                {
                    name: `${previousYear} costs`,
                    data: previousBuckets.map((bucket) => bucket.receivedNet),
                    colorVar: '--stor-chart-received',
                    type: 'line' as const,
                    dashStyle: 'Dash' as const,
                    opacity: 0.45,
                },
            ]
            : []),
    ]);
    const taxSeries = $derived<ColumnChartSeries[]>([
        { name: 'Income tax', data: taxChartRows.map((row) => row.tax.incomeTax), colorVar: '--stor-chart-income-tax' },
        { name: 'Social insurance', data: taxChartRows.map((row) => row.tax.socialInsurance), colorVar: '--stor-chart-social-insurance' },
        { name: 'Medical insurance', data: taxChartRows.map((row) => row.tax.medicalInsurance), colorVar: '--stor-chart-medical-insurance' },
    ]);

    const taxSplit = $derived.by(() => {
        if (!highlightedTax) return [];
        const earnings = highlightedTax.tax.totalEarnings;
        const parts = [
            { label: 'Net after tax', value: highlightedTax.tax.afterTaxEarnings, colorVar: '--stor-positive' },
            { label: 'Income tax', value: highlightedTax.tax.incomeTax, colorVar: '--stor-chart-income-tax' },
            { label: 'Social insurance', value: highlightedTax.tax.socialInsurance, colorVar: '--stor-chart-social-insurance' },
            { label: 'Medical insurance', value: highlightedTax.tax.medicalInsurance, colorVar: '--stor-chart-medical-insurance' },
        ];
        return parts.map((part) => ({ ...part, share: earnings > 0 ? (part.value / earnings) * 100 : 0 }));
    });

    const exclusionNotes = $derived.by(() => {
        const exclusions = dataset.exclusions;
        const notes: string[] = [];
        const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
        if (exclusions.issuedDrafts) notes.push(`${plural(exclusions.issuedDrafts, 'draft invoice')} excluded`);
        if (exclusions.receivedInReview) notes.push(`${plural(exclusions.receivedInReview, 'received invoice')} still in review excluded`);
        if (exclusions.receivedForeignCurrency) notes.push(`${plural(exclusions.receivedForeignCurrency, 'non-CZK received invoice')} excluded`);
        const undated = exclusions.issuedWithoutDate + exclusions.receivedWithoutDate;
        if (undated) notes.push(`${plural(undated, 'document')} without a valid date excluded`);
        if (basis === 'taxPoint' && exclusions.missingTaxPoint) {
            notes.push(`${plural(exclusions.missingTaxPoint, 'invoice')} without DUZP ${exclusions.missingTaxPoint === 1 ? 'uses' : 'use'} the issue date`);
        }
        if (basis === 'due' && exclusions.missingDueDate) {
            notes.push(`${plural(exclusions.missingDueDate, 'invoice')} without a due date ${exclusions.missingDueDate === 1 ? 'uses' : 'use'} the issue date`);
        }
        return notes;
    });

    // --- Report navigation and scope ------------------------------------------
    let showPeriodTable = $state(false);
    let showVatTable = $state(false);

    type AnalyticsSection = 'performance' | 'vat' | 'tax';
    const sectionLinks: Array<{ id: AnalyticsSection; label: string }> = [
        { id: 'performance', label: 'Performance' },
        { id: 'vat', label: 'VAT' },
        { id: 'tax', label: 'Income tax' },
    ];
    const activeSection = $derived<AnalyticsSection>(routeState.report ?? 'performance');
    function selectReport(id: AnalyticsSection): void {
        navigateInvoices({ report: id }, 'replace');
    }
    let scopeOpen = $state(false);
</script>

{#if loading || dataLoading}
    <section class="stor-panel p-[var(--stor-panel-padding)]" aria-label="Loading analytics">
        <DataPlaceholder rows={6} label="Loading analytics" />
    </section>
{:else if dataError}
    <EmptyState
        icon={IconChartLine}
        title="Analytics could not be loaded"
        description="The invoice data could not be read. Switch tabs and try again."
    />
{:else if !hasAnalyticsData}
    <EmptyState
        icon={IconChartLine}
        title="Nothing to analyse yet"
        description="Create issued invoices or upload received CZK invoices to build the tax overview."
    />
{:else}
        {#snippet scopeNotes()}
        {#if activeSection === 'performance'}
        <p class="mt-3 text-xs leading-5 text-[var(--stor-muted-text)]">
            {scopeLabel} · before VAT · CZK · {dataset.issued.length} issued / {dataset.received.length} received
        </p>
        {#if exclusionNotes.length}
            <details class="mt-1 text-xs leading-5 text-[var(--stor-muted-text)]">
                <summary class="cursor-pointer py-2 font-medium">Review data quality · {exclusionNotes.length} notices</summary>
                <p class="pb-2" role="status">{exclusionNotes.join(' · ')}</p>
            </details>
        {/if}
        {:else}
            <p class="mt-3 text-xs text-[var(--stor-muted-text)]">
                {activeSection === 'vat' ? `Tax point (DUZP) · ${vatScopeLabel} · CZK` : `Annual estimate · ${selectedYear === 'all' ? 'all years' : selectedYear} · CZK`}
            </p>
        {/if}
        {/snippet}
    <section
        class="stor-analytics-scope sticky top-0 z-20"
        aria-label="Analytics period and scope"
    >
        <div class="flex flex-wrap items-end gap-x-5 gap-y-3">
            <nav class="stor-page-tabs mobile-scroll flex min-w-0 max-w-full items-center overflow-x-auto" aria-label="Analytics reports" {@attach tabIndicator}>
                {#each sectionLinks as link (link.id)}
                    <button
                        type="button"
                        aria-current={activeSection === link.id ? 'true' : undefined}
                        onclick={() => selectReport(link.id)}
                        class="stor-page-tab"
                    >
                        {link.label}
                    </button>
                {/each}
            </nav>
        </div>
        <!-- Phones: the report's scope is one chip; its sheet holds the year, the date basis and the notes. -->
        <button type="button" class="mt-3 inline-flex h-9 items-center gap-1 rounded-full bg-[var(--stor-surface-raised)] px-3.5 text-sm font-semibold text-[var(--stor-ink)] shadow-[var(--stor-elevation-1)] md:hidden" aria-haspopup="dialog" onclick={() => (scopeOpen = true)}>
            {selectedYear === 'all' ? 'All years' : selectedYear}{#if activeSection === 'performance'} · {basis === 'issue' ? 'Issue date' : basis === 'taxPoint' ? 'Tax point' : 'Due date'}{/if}
            {#if exclusionNotes.length && activeSection === 'performance'}<span class="ml-1 h-1.5 w-1.5 rounded-full bg-[var(--stor-warning)]" aria-label={`${exclusionNotes.length} data notes`}></span>{/if}
            <IconChevronDown class="h-4 w-4 text-[var(--stor-muted-text)]" />
        </button>
        <div class="mt-4 flex flex-wrap items-center gap-3 max-md:hidden">
            <h2 class="text-2xl font-semibold tracking-tight text-[var(--stor-ink)]">{sectionLinks.find((link) => link.id === activeSection)?.label}</h2>
            <div class="ml-auto flex items-end gap-2">
                <Select
                    ariaLabel="Report year"
                    class="w-28"
                    value={String(selectedYear)}
                    options={yearOptions}
                    onValueChange={selectYear}
                />
                {#if activeSection === 'performance'}
                    <Select ariaLabel="Date basis" class="w-36" value={basis}
                        options={[{ value: 'issue', label: 'Issue date' }, { value: 'taxPoint', label: 'Tax point' }, { value: 'due', label: 'Due date' }]}
                        onValueChange={selectBasis} />
                {/if}
            </div>
        </div>
        <div class="max-md:hidden">{@render scopeNotes()}</div>
    </section>

    <Modal show={scopeOpen} title="Report scope" onClose={() => (scopeOpen = false)}>
        <div class="flex flex-col gap-3">
            <label class="block text-sm font-medium text-[var(--stor-ink)]">Year
                <Select ariaLabel="Report year" class="mt-1.5" value={String(selectedYear)} options={yearOptions} onValueChange={selectYear} />
            </label>
            {#if activeSection === 'performance'}
                <label class="block text-sm font-medium text-[var(--stor-ink)]">Group by
                    <Select ariaLabel="Date basis" class="mt-1.5" value={basis}
                        options={[{ value: 'issue', label: 'Issue date' }, { value: 'taxPoint', label: 'Tax point' }, { value: 'due', label: 'Due date' }]}
                        onValueChange={selectBasis} />
                </label>
            {/if}
            {@render scopeNotes()}
        </div>
    </Modal>

    {#if activeSection === 'performance'}
    <div class="stor-performance-report stor-panel space-y-4">

        <section
            class="stor-analytics-hero grid gap-5 p-[var(--stor-panel-padding)] sm:grid-cols-3 lg:gap-8"
            aria-label={`Totals for ${periodLabel}`}
        >
            {#each kpis as kpi (kpi.label)}
                <div class="min-w-0">
                    <p class="text-xs font-medium text-[var(--stor-muted-text)]">{kpi.label}</p>
                    <p class="stor-report-value mt-2 font-semibold tabular-nums {kpi.tone}">{kpi.value.replace(/\s*Kč$/, '')}<span class="ml-1 text-sm font-medium text-[var(--stor-muted-text)]">Kč</span></p>
                    <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--stor-muted-text)]">
                        {#if kpi.delta}
                            <span class="inline-flex items-center gap-1 rounded-full bg-[var(--stor-surface-muted)] px-2 py-0.5 font-semibold tabular-nums {kpi.delta.tone === 'positive' ? 'text-[var(--stor-positive)]' : kpi.delta.tone === 'negative' ? 'text-[var(--stor-negative)]' : 'text-[var(--stor-muted-text)]'}">
                                <span aria-hidden="true">{kpi.delta.trend === 'up' ? '▲' : '▼'}</span>
                                <span class="sr-only">{kpi.delta.trend === 'up' ? 'up' : 'down'}</span>
                                {kpi.delta.text}
                            </span>
                        {/if}
                        <span>{kpi.detail}</span>
                    </div>
                    {#if kpi.delta && comparison}
                        <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">{comparison.label}</p>
                    {/if}
                </div>
            {/each}
        </section>

        <section class="stor-performance-chart" aria-label="Revenue and costs chart">
            <div class="stor-panel-header">
                <div class="min-w-0">
                    <h2 class="text-base font-semibold text-[var(--stor-ink)]">Revenue and costs</h2>
                    <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                        {periodLabel} · before VAT{#if comparison} · dashed lines are {previousYear}{/if}{#if currentBucketIndex >= 0} · shaded band is the current period{/if}
                    </p>
                </div>
                <div class="flex flex-wrap items-center gap-3">
                    <Tabs.Root value={granularity} onValueChange={selectGranularity}>
                        <Tabs.List class="stor-segmented-control inline-grid grid-cols-3" aria-label="Group by">
                            <Tabs.Trigger value="month" class="stor-segmented-option">Months</Tabs.Trigger>
                            <Tabs.Trigger value="quarter" class="stor-segmented-option">Quarters</Tabs.Trigger>
                            <Tabs.Trigger value="year" class="stor-segmented-option">Years</Tabs.Trigger>
                        </Tabs.List>
                    </Tabs.Root>
                    {#if previousYear !== null && previousBuckets.length}
                        <label class="flex min-h-11 items-center gap-2 text-xs text-[var(--stor-muted-text)]"><input type="checkbox" bind:checked={comparePrevious} /> Compare {previousYear}</label>
                    {/if}
                </div>
            </div>
            <div class="space-y-5 px-[var(--stor-panel-padding)] pb-[var(--stor-panel-padding)]">
                <div class="min-w-0">
                    <InvoiceColumnChart
                        categories={buckets.map((bucket) => bucket.label)}
                        series={revenueSeries}
                        formatValue={chartMoney}
                        ariaLabel={`Revenue and costs, ${periodLabel}`}
                        emptyMessage="No invoices in this period."
                        markerIndex={currentBucketIndex >= 0 ? currentBucketIndex : null}
                        onPointClick={onRevenuePoint}
                    />
                    <p class="mt-2 text-xs text-[var(--stor-muted-text)]">Select a column or choose a period to inspect its invoices.</p>
                </div>
                {#if inspectedBucket}
                    <section class="stor-period-inspection border-t border-[var(--stor-border)] pt-4" aria-label="Selected period">
                        <div class="flex flex-wrap items-center justify-between gap-3">
                            <h3 class="font-semibold text-[var(--stor-ink)]">{inspectedBucket.label}{#if inspectedBucket.key === currentBucketKey} · partial period{/if}</h3>
                            <Select ariaLabel="Inspect period" value={inspectedBucket.key} options={buckets.map((bucket) => ({ value: bucket.key, label: bucket.label }))} onValueChange={(value) => inspectedKey = value} class="w-36" />
                        </div>
                        <dl class="my-4 grid grid-cols-3 gap-3 text-xs text-[var(--stor-muted-text)]">
                            <div><dt>Revenue</dt><dd class="mt-1 font-semibold tabular-nums text-[var(--stor-ink)]">{money(inspectedBucket.issuedNet)}</dd></div>
                            <div><dt>Costs</dt><dd class="mt-1 font-semibold tabular-nums text-[var(--stor-ink)]">{money(inspectedBucket.receivedNet)}</dd></div>
                            <div><dt>Difference</dt><dd class="mt-1 font-semibold tabular-nums text-[var(--stor-ink)]">{money(inspectedBucket.profit)}</dd></div>
                        </dl>
                        <div class="flex flex-wrap gap-x-6">
                            <button type="button" class="min-h-11 text-sm font-semibold text-[var(--stor-accent-strong)]" onclick={() => openInspected('issued')}>View issued invoices →</button>
                            <button type="button" class="min-h-11 text-sm font-semibold text-[var(--stor-accent-strong)]" onclick={() => openInspected('received')}>View received invoices →</button>
                        </div>
                    </section>
                {/if}
                <div class="min-w-0">
                    <div class="flex items-center justify-between gap-3">
                        <h3 class="text-sm font-semibold text-[var(--stor-ink)]">Period detail</h3>
                        <button
                            type="button"
                            class="min-h-8 text-xs font-semibold text-[var(--stor-accent-strong)]"
                            aria-expanded={showPeriodTable}
                            onclick={() => showPeriodTable = !showPeriodTable}
                        >
                            {showPeriodTable ? 'Hide table' : 'Show table'}
                        </button>
                    </div>
                    <div class={showPeriodTable ? 'mt-3' : 'hidden'}>
                        <div class="max-h-[22rem] overflow-auto rounded-xl border border-[var(--stor-border)]">
                            <table class="w-full min-w-[26rem] border-collapse text-left text-sm" aria-label="Period detail">
                                <thead class="sticky top-0 z-10 bg-[var(--stor-surface-muted)] text-xs text-[var(--stor-muted-text)]">
                                    <tr>
                                        <th scope="col" class="px-2 py-2">Period</th>
                                        <th scope="col" class="px-2 py-2 text-right">Revenue</th>
                                        <th scope="col" class="px-2 py-2 text-right">Costs</th>
                                        <th scope="col" class="px-2 py-2 text-right">Difference</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-[var(--stor-border)]">
                                    {#each buckets as bucket, index (bucket.key)}
                                        <tr>
                                            <td class="whitespace-nowrap px-2 py-2">
                                                <button
                                                    type="button"
                                                    onclick={() => drillBucket(index)}
                                                    class="font-medium tabular-nums text-[var(--stor-accent-strong)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--stor-focus)]"
                                                >
                                                    {bucket.label}
                                                </button>
                                            </td>
                                            <td class="whitespace-nowrap px-2 py-2 text-right tabular-nums">{money(bucket.issuedNet)}</td>
                                            <td class="whitespace-nowrap px-2 py-2 text-right tabular-nums">{money(bucket.receivedNet)}</td>
                                            <td class="whitespace-nowrap px-2 py-2 text-right tabular-nums {bucket.profit < 0 ? 'text-[var(--stor-negative)]' : 'text-[var(--stor-ink)]'}">{money(bucket.profit)}</td>
                                        </tr>
                                    {/each}
                                    <tr class="sticky bottom-0 bg-[var(--stor-surface-muted)] font-semibold text-[var(--stor-ink)]">
                                        <td class="px-2 py-2">Total</td>
                                        <td class="whitespace-nowrap px-2 py-2 text-right tabular-nums">{money(totals.issuedNet)}</td>
                                        <td class="whitespace-nowrap px-2 py-2 text-right tabular-nums">{money(totals.receivedNet)}</td>
                                        <td class="whitespace-nowrap px-2 py-2 text-right tabular-nums {totals.profit < 0 ? 'text-[var(--stor-negative)]' : 'text-[var(--stor-ink)]'}">{money(totals.profit)}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    </div>
    {:else if activeSection === 'vat'}

    <div class="space-y-4">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
            <h2 class="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--stor-ink)]">Obligations</h2>
            <p class="text-xs text-[var(--stor-muted-text)]">Statutory periods by tax point (DUZP) — these ignore the period view above</p>
        </div>

        <section class="stor-panel" aria-label="VAT by quarter">
            <div class="stor-panel-header">
                <div class="min-w-0">
                    <h2 class="text-base font-semibold text-[var(--stor-ink)]">VAT by quarter</h2>
                    <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                        Tax point (DUZP) only · output VAT − input VAT · CZK only · {vatScopeLabel} · {vatReport.totals.issuedCount} issued / {vatReport.totals.receivedCount} received
                    </p>
                </div>
                {#if showVatDeadline}
                    <p class="shrink-0 text-xs text-[var(--stor-muted-text)]">
                        Next filing <strong class="font-semibold tabular-nums text-[var(--stor-ink)]">{formatInvoiceDate(vatDeadline)}</strong>
                    </p>
                {/if}
            </div>
            <div class="grid gap-4 px-[var(--stor-panel-padding)] pb-5 sm:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))] sm:items-end">
                <div>
                    <p class="text-sm font-medium text-[var(--stor-muted-text)]">{vatReport.totals.vatDue < 0 ? 'VAT credit' : 'VAT due'}</p>
                    <p class="mt-1 text-3xl font-semibold tracking-[-0.03em] tabular-nums {vatReport.totals.vatDue < 0 ? 'text-[var(--stor-positive)]' : 'text-[var(--stor-ink)]'}">
                        {money(Math.abs(vatReport.totals.vatDue))}
                    </p>
                    <p class="mt-1 text-xs text-[var(--stor-muted-text)]">{vatTotalLabel} · output minus input VAT</p>
                </div>
                <div>
                    <p class="text-sm font-medium text-[var(--stor-muted-text)]">Output VAT</p>
                    <p class="mt-1 text-xl font-semibold tabular-nums text-[var(--stor-ink)]">{money(vatReport.totals.issuedVat)}</p>
                </div>
                <div>
                    <p class="text-sm font-medium text-[var(--stor-muted-text)]">Input VAT</p>
                    <p class="mt-1 text-xl font-semibold tabular-nums text-[var(--stor-ink)]">{money(vatReport.totals.receivedVat)}</p>
                </div>
            </div>
            <div class="grid gap-5 px-[var(--stor-panel-padding)] pb-[var(--stor-panel-padding)] lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
                <div class="min-w-0">
                    {#if vatReport.quarters.length > 0}
                        <InvoiceColumnChart
                            categories={vatReport.quarters.map((row) => row.label)}
                            series={vatSeries}
                            formatValue={chartMoney}
                            ariaLabel={`Output and input VAT by quarter for ${vatScopeLabel}`}
                            emptyMessage="No documents with a tax point date in this period."
                            markerIndex={vatMarkerIndex >= 0 ? vatMarkerIndex : null}
                            onPointClick={(point) => drillVatQuarter(point.index, point.seriesIndex === 0 ? 'issued' : 'received')}
                        />
                        <p class="mt-2 text-xs text-[var(--stor-muted-text)]">Click a segment to open that direction's invoices for the quarter's DUZP.</p>
                    {:else}
                        <p class="text-sm text-[var(--stor-muted-text)]">No documents with a tax point date in this period.</p>
                    {/if}
                </div>
                <div class="min-w-0">
                    <div class="flex items-center justify-between gap-3">
                        <h3 class="text-sm font-semibold text-[var(--stor-ink)]">Quarter detail</h3>
                        <button
                            type="button"
                            class="min-h-8 text-xs font-semibold text-[var(--stor-accent-strong)] lg:hidden"
                            aria-expanded={showVatTable}
                            onclick={() => showVatTable = !showVatTable}
                        >
                            {showVatTable ? 'Hide table' : 'Show table'}
                        </button>
                    </div>
                    {#if vatReport.quarters.length > 0}
                        <div class={showVatTable ? 'mt-3' : 'mt-3 hidden lg:block'}>
                            <div class="overflow-x-auto rounded-xl border border-[var(--stor-border)]">
                                <table class="w-full min-w-[26rem] border-collapse text-left text-sm" aria-label="VAT by quarter detail">
                                    <thead class="bg-[var(--stor-surface-muted)] text-xs text-[var(--stor-muted-text)]">
                                        <tr>
                                            <th scope="col" class="px-3 py-2">Quarter</th>
                                            <th scope="col" class="px-3 py-2 text-right">Output</th>
                                            <th scope="col" class="px-3 py-2 text-right">Input</th>
                                            <th scope="col" class="px-3 py-2 text-right">Due / credit</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-[var(--stor-border)]">
                                        {#each vatReport.quarters as row, index (row.key)}
                                            <tr class={vatMarkerIndex === index ? 'bg-[var(--stor-accent-soft)]' : ''}>
                                                <td class="whitespace-nowrap px-3 py-2">
                                                    <button
                                                        type="button"
                                                        onclick={() => drillVatQuarter(index, 'issued')}
                                                        class="font-medium tabular-nums text-[var(--stor-accent-strong)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--stor-focus)]"
                                                    >
                                                        {row.label}
                                                    </button>
                                                </td>
                                                <td class="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                                                    <button
                                                        type="button"
                                                        aria-label={`Open issued invoices for ${row.label}`}
                                                        onclick={() => drillVatQuarter(index, 'issued')}
                                                        class="rounded hover:text-[var(--stor-accent-strong)] focus-visible:outline-2 focus-visible:outline-[var(--stor-focus)]"
                                                    >
                                                        {money(row.issuedVat)}
                                                    </button>
                                                </td>
                                                <td class="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                                                    <button
                                                        type="button"
                                                        aria-label={`Open received invoices for ${row.label}`}
                                                        onclick={() => drillVatQuarter(index, 'received')}
                                                        class="rounded hover:text-[var(--stor-accent-strong)] focus-visible:outline-2 focus-visible:outline-[var(--stor-focus)]"
                                                    >
                                                        {money(row.receivedVat)}
                                                    </button>
                                                </td>
                                                <td class="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums {row.vatDue < 0 ? 'text-[var(--stor-positive)]' : 'text-[var(--stor-ink)]'}">{money(row.vatDue)}</td>
                                            </tr>
                                        {/each}
                                        <tr class="bg-[var(--stor-surface-muted)] font-semibold text-[var(--stor-ink)]">
                                            <td class="px-3 py-2">{vatTotalLabel}</td>
                                            <td class="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(vatReport.totals.issuedVat)}</td>
                                            <td class="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(vatReport.totals.receivedVat)}</td>
                                            <td class="whitespace-nowrap px-3 py-2 text-right tabular-nums {vatReport.totals.vatDue < 0 ? 'text-[var(--stor-positive)]' : 'text-[var(--stor-ink)]'}">{money(vatReport.totals.vatDue)}</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    {/if}
                </div>
            </div>
            {#if vatExclusionNote}
                <p class="px-[var(--stor-panel-padding)] pb-[var(--stor-panel-padding)] text-xs leading-5 text-[var(--stor-muted-text)]" role="status">{vatExclusionNote}</p>
            {/if}
        </section>
    </div>
    {:else}

    <div class="space-y-4">
        <section class="stor-panel" aria-label="Income tax estimate">
            <div class="stor-panel-header">
                <div class="min-w-0">
                    <h2 class="text-base font-semibold text-[var(--stor-ink)]">Income tax estimate</h2>
                    <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                        Annual flat-rate {percent(taxConfig.flatRate)} on issued revenue (before VAT), by estimated payment date (due date){#if highlightedTax} · {highlightedTax.year}{/if}
                    </p>
                </div>
            </div>
            <div class="grid gap-5 px-[var(--stor-panel-padding)] pb-[var(--stor-panel-padding)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                <div class="min-w-0 space-y-5">
                    {#if highlightedTax}
                        <div>
                            <p class="text-xs font-medium text-[var(--stor-muted-text)]">Total taxes {highlightedTax.year}</p>
                            <p class="mt-1 break-words text-2xl font-semibold tabular-nums text-[var(--stor-ink)]">{money(highlightedTax.tax.totalTaxes)}</p>
                            <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                                Effective rate <strong class="font-semibold tabular-nums text-[var(--stor-ink)]">{percent(highlightedTax.tax.effectiveRate)}</strong>
                                <span aria-hidden="true"> · </span>
                                Net after tax <strong class="font-semibold tabular-nums text-[var(--stor-ink)]">{money(highlightedTax.tax.afterTaxEarnings)}</strong>
                            </p>
                        </div>

                        <dl class="grid grid-cols-2 gap-3">
                            {#each [
                                {
                                    label: 'Taxable revenue (net)',
                                    value: money(highlightedTax.tax.totalEarnings),
                                    detail: `${highlightedTax.issuedCount} issued invoice${highlightedTax.issuedCount === 1 ? '' : 's'}`,
                                },
                                {
                                    label: 'Income tax',
                                    value: money(highlightedTax.tax.incomeTax),
                                    detail: `${percent(taxConfig.incomeTax)} after the ${money(taxConfig.incomeTaxDiscount)} discount`,
                                },
                                {
                                    label: 'Social insurance',
                                    value: money(highlightedTax.tax.socialInsurance),
                                    detail: `${percent(taxConfig.socialInsurance)} of ${percent(taxConfig.socialInsuranceBase)} of the base`,
                                },
                                {
                                    label: 'Medical insurance',
                                    value: money(highlightedTax.tax.medicalInsurance),
                                    detail: `${percent(taxConfig.medicalInsurance)} of ${percent(taxConfig.medicalInsuranceBase)} of the base`,
                                },
                            ] as card}
                                <div class="min-w-0 rounded-xl bg-[var(--stor-surface-muted)] p-3">
                                    <dt class="text-xs font-medium uppercase tracking-wide text-[var(--stor-muted-text)]">{card.label}</dt>
                                    <dd class="mt-1 break-words text-lg font-semibold tabular-nums text-[var(--stor-ink)]">{card.value}</dd>
                                    <p class="mt-0.5 text-xs leading-5 text-[var(--stor-muted-text)]">{card.detail}</p>
                                </div>
                            {/each}
                        </dl>

                        <div>
                            <div class="flex h-3 overflow-hidden rounded-full bg-[var(--stor-surface-muted)]" role="img" aria-label={`Annual split for ${highlightedTax.year}`}>
                                {#each taxSplit as part (part.label)}
                                    <span style:width={`${part.share}%`} style:background={`var(${part.colorVar})`}></span>
                                {/each}
                            </div>
                            <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--stor-muted-text)]">
                                {#each taxSplit as part (part.label)}
                                    <span class="inline-flex items-center gap-1.5">
                                        <span class="h-2.5 w-2.5 rounded-full" style:background={`var(${part.colorVar})`}></span>
                                        {part.label} <strong class="font-semibold tabular-nums text-[var(--stor-ink)]">{money(part.value)}</strong>
                                    </span>
                                {/each}
                            </div>
                            {#if showIncomeTaxDeadline && incomeTaxDeadline && highlightedTax}
                                <p class="mt-2 text-xs text-[var(--stor-muted-text)]">
                                    Filing hint: {highlightedTax.year} return due <strong class="font-semibold tabular-nums text-[var(--stor-ink)]">{formatInvoiceDate(incomeTaxDeadline)}</strong> (electronic)
                                </p>
                            {/if}
                        </div>
                    {/if}
                </div>

                <div class="min-w-0">
                    <h3 class="text-sm font-semibold text-[var(--stor-ink)]">Tax totals by year</h3>
                    <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">Income tax, social insurance and medical insurance per calendar year.</p>
                    <div class="mt-3">
                        <InvoiceColumnChart
                            categories={taxChartRows.map((row) => String(row.year))}
                            series={taxSeries}
                            stacked
                            height={260}
                            formatValue={chartMoney}
                            ariaLabel="Income tax, social insurance and medical insurance by year"
                            emptyMessage="No years with invoices yet."
                        />
                    </div>
                </div>
            </div>
        </section>

        <section class="stor-panel" aria-label="Tax by year detail">
            <div class="stor-panel-header">
                <div class="min-w-0">
                    <h2 class="text-base font-semibold text-[var(--stor-ink)]">Yearly tax detail</h2>
                    <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">Every year on record; select a year to scope the dashboard to it.</p>
                </div>
            </div>
            <div class="space-y-5 px-[var(--stor-panel-padding)] pb-[var(--stor-panel-padding)]">
                <div class="overflow-x-auto">
                    <table class="w-full min-w-[54rem] border-collapse text-left text-sm" aria-label="Yearly tax detail">
                        <thead class="bg-[var(--stor-surface-muted)] text-xs text-[var(--stor-muted-text)]">
                            <tr>
                                <th scope="col" class="px-3 py-3">Year</th>
                                <th scope="col" class="px-3 py-3 text-right">Revenue (net)</th>
                                <th scope="col" class="px-3 py-3 text-right">Costs (net)</th>
                                <th scope="col" class="px-3 py-3 text-right">Income tax</th>
                                <th scope="col" class="px-3 py-3 text-right">Social insurance</th>
                                <th scope="col" class="px-3 py-3 text-right">Medical insurance</th>
                                <th scope="col" class="px-3 py-3 text-right">Total taxes</th>
                                <th scope="col" class="px-3 py-3 text-right">Net after tax</th>
                                <th scope="col" class="px-3 py-3 text-right">Effective rate</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-[var(--stor-border)]">
                            {#each taxRows as row (row.year)}
                                <tr class={selectedYear === row.year ? 'bg-[var(--stor-accent-soft)]' : ''}>
                                    <td class="px-3 py-3">
                                        <button
                                            type="button"
                                            aria-pressed={selectedYear === row.year}
                                            onclick={() => selectYear(String(row.year))}
                                            class="font-semibold tabular-nums text-[var(--stor-accent-strong)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--stor-focus)]"
                                        >
                                            {row.year}
                                        </button>
                                    </td>
                                    <td class="whitespace-nowrap px-3 py-3 text-right tabular-nums">{money(row.revenue)}</td>
                                    <td class="whitespace-nowrap px-3 py-3 text-right tabular-nums">{money(row.costs)}</td>
                                    <td class="whitespace-nowrap px-3 py-3 text-right tabular-nums">{money(row.tax.incomeTax)}</td>
                                    <td class="whitespace-nowrap px-3 py-3 text-right tabular-nums">{money(row.tax.socialInsurance)}</td>
                                    <td class="whitespace-nowrap px-3 py-3 text-right tabular-nums">{money(row.tax.medicalInsurance)}</td>
                                    <td class="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums">{money(row.tax.totalTaxes)}</td>
                                    <td class="whitespace-nowrap px-3 py-3 text-right tabular-nums">{money(row.tax.afterTaxEarnings)}</td>
                                    <td class="whitespace-nowrap px-3 py-3 text-right tabular-nums">{percent(row.tax.effectiveRate)}</td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>

                <details class="p-1">
                    <summary class="cursor-pointer text-sm font-semibold text-[var(--stor-ink)]">Tax assumptions</summary>
                    <dl class="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-xs text-[var(--stor-muted-text)]">
                        <dt>Flat-rate deduction</dt><dd>{percent(taxConfig.flatRate)}</dd>
                        <dt>Income tax</dt><dd>{percent(taxConfig.incomeTax)}</dd>
                        <dt>Social base</dt><dd>{percent(taxConfig.socialInsuranceBase)}</dd>
                        <dt>Medical base</dt><dd>{percent(taxConfig.medicalInsuranceBase)}</dd>
                        <dt>Social insurance</dt><dd>{percent(taxConfig.socialInsurance)}</dd>
                        <dt>Medical insurance</dt><dd>{percent(taxConfig.medicalInsurance)}</dd>
                        <dt>Annual discount</dt><dd>{money(taxConfig.incomeTaxDiscount)}</dd>
                        <dt>Tariff cap</dt><dd>{money(taxConfig.maxTariff)}</dd>
                        <dt>VAT period</dt><dd>{vatConfig.period === 'quarter' ? 'Quarterly' : 'Monthly'}, due day {vatConfig.dueDayOfMonth}</dd>
                        <dt>Income tax return</dt><dd>{vatConfig.incomeTaxDeadline.day}. {vatConfig.incomeTaxDeadline.month}. of the following year (electronic)</dd>
                    </dl>
                    <p class="mt-3 text-xs leading-5 text-[var(--stor-muted-text)]">
                        The estimate follows the calculator: {percent(taxConfig.flatRate)} flat-rate expenses on issued revenue before VAT, the annual discount applied once per year, and no flat rate above the tariff cap. Every document is counted in the year of its estimated payment date: the recorded paid date when available, otherwise the due date, since issued invoices do not store a payment date yet. Received invoices are shown as context only. Year-over-year chips compare the same number of periods, so a part-finished year is measured against the same months of the previous year. Filing hints come from the configurable assumptions above and are not tax advice.
                    </p>
                </details>
            </div>
        </section>
    </div>
    {/if}
{/if}
