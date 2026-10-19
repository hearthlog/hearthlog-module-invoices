<script lang="ts">
    import { MediaQuery } from 'svelte/reactivity';
    import { longPress, phoneHeader } from '@hearthlog/sdk/runtime';
        import { Modal } from "@hearthlog/sdk/ui";
    import { ChoiceChips } from "@hearthlog/sdk/ui";
    import { Select } from "@hearthlog/sdk/ui";
    import { FoldLine } from "@hearthlog/sdk/ui";
    import IconChevronRight from '~icons/mdi/chevron-right';
    import { untrack, type Snippet } from 'svelte';
    import type { SortingState } from '@tanstack/svelte-table';
    import IconArrowDown from '~icons/mdi/arrow-down';
    import IconArrowUp from '~icons/mdi/arrow-up';
    import IconUnfoldMore from '~icons/mdi/unfold-more-horizontal';
    import IconFilter from '~icons/mdi/filter-variant';
    import IconClose from '~icons/mdi/close';
    import { Drawer } from "@hearthlog/sdk/ui";
    import { EmptyState } from "@hearthlog/sdk/ui";
    import { Button } from "@hearthlog/sdk/ui";
    import { CommandOnly } from "@hearthlog/sdk/ui";
    import { queryDatabase } from '@hearthlog/sdk/data';
    import type {
        InvoiceListRequest,
        InvoiceListResult,
        InvoiceSelectionRequest,
        InvoiceSelectionScope,
        InvoiceSelectionSummary,
    } from '../../data/invoice-list.js';
    import { browser } from '$app/env';
    import InvoiceAmountRange from './InvoiceAmountRange.svelte';
    import InvoiceDateRange from './InvoiceDateRange.svelte';
    import { createInvoiceListColumnHelper, createInvoiceListTable } from '../../invoices/list-table.js';
    import { EXPENSE_TYPES, expenseTypeLabel } from '../../invoices/expense-types.js';

    import {
        DEFAULT_INVOICE_SORT,
        emptyInvoiceFilters,
        EXPENSE_TYPE_UNSET,
        hasInvoiceListFilters as hasActiveFilters,
        type DateRange,
        type InvoiceListFilters,
        type InvoiceListRow,
        type InvoiceSelection,
        type InvoiceSort,
        type NumberRange,
    } from '../../invoices/list-contracts.js';
    import { invoiceRouteFromUrl, invoiceRouteState, syncInvoiceListRoute } from '../../invoices/url.js';
    import { formatInvoiceDate } from '../../invoices/format.js';

    let {
        direction,
        today,
        revision = 0,
        tableLabel,
        activeId = null,
        partyLabel,
        statusOptions,
        loading = false,
        emptyTitle,
        emptyDescription,
        statusBadge,
        actions,
        storageLabel,
        onSelect,
        onMarkPaid,
        onDelete,
        onCreate,
        onImport,
        overdueCount = 0,
        createLabel = 'Create invoice',
        showExpenseType = false,
        toolbar,

        /** Local calendar date (YYYY-MM-DD); the SQL query resolves overdue against it. */
        /** Bumped by the page on every invalidation so the query re-reads. */
        /** Overdue invoices in the active log; shows a banner that applies the Overdue filter. */
    }: { 
        direction: 'issued' | 'received';
        today: string;
        revision?: number;
        tableLabel: string;
        activeId?: string | null;
        partyLabel: string;
        statusOptions: Array<{ value: string; label: string }>;
        loading?: boolean;
        emptyTitle: string;
        emptyDescription: string;
        statusBadge: Snippet<[InvoiceListRow]>;
        actions: Snippet<[InvoiceListRow]>;
        storageLabel?: (status: string) => string;
        onSelect: (row: InvoiceListRow) => void;
        onMarkPaid: (selection: InvoiceSelection) => Promise<boolean>;
        onDelete: (selection: InvoiceSelection) => void;
        onCreate?: () => void;
        /** Phones offer Import in the list options. */
        onImport?: () => void;
        overdueCount?: number;
        createLabel?: string;
        /** Received invoices: adds the expense type column and filter. */
        showExpenseType?: boolean;
        /** Extra actions beside the result count. */
        toolbar?: Snippet;
    } = $props();

    const PAGE_SIZE = 50;

    // --- Controls, seeded from the URL so a reload or a shared link restores them ---
    // The DUZP range is the one analytics drill-through sets; the rest are
    // typed or picked in the filter drawer. Only the direction the URL names
    // may adopt that narrowing; the kept-alive table for the other tab starts
    // from the defaults so activating it never shows the other tab's rows.
    const seeded = invoiceRouteState();
    // `direction` never changes for a mounted table, so reading it once here is
    // deliberate; untrack keeps the seeding from re-running as a dependency.
    const seedControls = seeded.tab === untrack(() => direction);
    const seededFilters = seedControls ? seeded.filters : emptyInvoiceFilters();
    let searchFilter = $state(seededFilters.search);
    let invoiceFilter = $state(seededFilters.invoiceNumber);
    let partyFilter = $state(seededFilters.party);
    let statusFilter = $state(seededFilters.status || 'all');
    let typeFilter = $state(seededFilters.expenseType);
    let statusRow = $state<HTMLDivElement | null>(null);
    let issuedRange = $state<DateRange>({ ...seededFilters.issued });
    let dueRange = $state<DateRange>({ ...seededFilters.due });
    // Seeded from the URL so an analytics drill-through into a DUZP range
    // lands with the filter already applied and visible as a chip.
    let taxPointRange = $state<DateRange>({ ...seededFilters.taxPoint });
    let beforeRange = $state<NumberRange>({ ...seededFilters.beforeVat });
    let afterRange = $state<NumberRange>({ ...seededFilters.afterVat });
    let sorting = $state<SortingState>([{ ...seedControls ? seeded.sort : DEFAULT_INVOICE_SORT }]);
    let page = $state(seedControls ? seeded.page : 1);

    const currentFilters = $derived<InvoiceListFilters>({
        search: searchFilter,
        invoiceNumber: invoiceFilter,
        party: partyFilter,
        status: statusFilter,
        expenseType: typeFilter,
        issued: issuedRange,
        due: dueRange,
        taxPoint: taxPointRange,
        beforeVat: beforeRange,
        afterVat: afterRange,
    });
    const currentSort = $derived<InvoiceSort>(sorting[0] ?? { ...DEFAULT_INVOICE_SORT });
    const hasFilters = $derived(hasActiveFilters(currentFilters));
    // Only the visible direction owns the URL's list state; the kept-alive
    // table for the other tab must neither publish nor adopt it while hidden.
    const isActive = $derived(invoiceRouteState().tab === direction);

    // --- Selection: explicit ids, or every row matching the filters ---
    let selectedIds = $state<string[]>([]);
    let allMatching = $state(false);
    let excludedIds = $state<string[]>([]);

    let queryResult = $state<InvoiceListResult | null>(null);
    let queryLoading = $state(true);
    let queryError = $state('');
    let queryNonce = $state(0);
    let summary = $state<InvoiceSelectionSummary>({ count: 0, blocked: 0, unpaid: 0, totals: [] });
    let markingPaid = $state(false);
    let filtersOpen = $state(false);

    // Re-read the controls from the address bar; used when this table becomes
    // the visible tab and when Back/Forward lands on a URL without shallow state.
    function reseedFromUrl(): void {
        const next = invoiceRouteFromUrl();
        searchFilter = next.filters.search;
        invoiceFilter = next.filters.invoiceNumber;
        partyFilter = next.filters.party;
        statusFilter = next.filters.status || 'all';
        typeFilter = next.filters.expenseType;
        issuedRange = { ...next.filters.issued };
        dueRange = { ...next.filters.due };
        taxPointRange = { ...next.filters.taxPoint };
        beforeRange = { ...next.filters.beforeVat };
        afterRange = { ...next.filters.afterVat };
        sorting = [{ ...next.sort }];
        page = next.page;
    }

    // A tab switch resets the URL's narrowing; the newly visible table adopts
    // it before mirroring its own controls back, so the reset still holds.
    $effect(() => {
        if (!browser || !isActive) return;
        reseedFromUrl();
    });

    // A kept-alive table must not hold its filter drawer over another tab.
    $effect(() => {
        if (!isActive) filtersOpen = false;
    });

    // Mirror the controls into the URL. The helper is a no-op when the address
    // bar already describes this state, so the effect settles after one pass.
    // Only the visible direction writes; the hidden table must not overwrite it.
    $effect(() => {
        if (!browser || !isActive) return;
        syncInvoiceListRoute({ filters: currentFilters, sort: currentSort, page });
    });

    // Back and Forward land on an address bar without shallow state, so the
    // visible controls are re-read from it.
    $effect(() => {
        if (!browser) return;
        const reseed = (): void => {
            if (!isActive) return;
            reseedFromUrl();
        };
        window.addEventListener('popstate', reseed);
        return () => window.removeEventListener('popstate', reseed);
    });

    // A deep-linked status can begin beyond the mobile row's visible edge.
    // Keep the selected option in view without scrolling the whole page.
    $effect(() => {
        void statusFilter;
        if (!statusRow) return;
        const frame = requestAnimationFrame(() => {
            const selected = statusRow?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
            if (!selected || !statusRow) return;
            const rowRect = statusRow.getBoundingClientRect();
            const selectedRect = selected.getBoundingClientRect();
            if (selectedRect.left < rowRect.left) statusRow.scrollLeft -= rowRect.left - selectedRect.left;
            else if (selectedRect.right > rowRect.right) statusRow.scrollLeft += selectedRect.right - rowRect.right;
        });
        return () => cancelAnimationFrame(frame);
    });

    // Re-narrowing the list redefines what "all matching" means, so that wider
    // selection is dropped rather than silently retargeted.
    $effect(() => {
        void currentFilters;
        allMatching = false;
        excludedIds = [];
    });

    $effect(() => {
        const request: InvoiceListRequest = {
            direction,
            today,
            filters: currentFilters,
            sort: currentSort,
            page,
            pageSize: PAGE_SIZE,
        };
        void revision;
        void queryNonce;
        if (loading) return;
        let cancelled = false;
        queryLoading = true;
        queryError = '';
        queryDatabase((repositories) => repositories.invoices.queryList(request))
            .then((result) => {
                if (cancelled) return;
                queryResult = result;
                // The query clamps a page number that outlived its rows; follow
                // it so the footer and the address bar agree.
                if (result.page !== page) page = result.page;
            })
            .catch((error) => {
                if (!cancelled) queryError = error instanceof Error ? error.message : 'Could not load invoices.';
            })
            .finally(() => {
                if (!cancelled) queryLoading = false;
            });
        return () => {
            cancelled = true;
        };
    });

    // Totals are a separate query so ticking a checkbox never re-scans the list.
    $effect(() => {
        const active = allMatching || selectedIds.length > 0;
        const scope: InvoiceSelectionScope = {
            ids: allMatching ? null : [...selectedIds],
            filters: currentFilters,
            excludedIds: allMatching ? [...excludedIds] : [],
        };
        void revision;
        if (!active) {
            summary = { count: 0, blocked: 0, unpaid: 0, totals: [] };
            return;
        }
        let cancelled = false;
        queryDatabase((repositories) =>
            repositories.invoices.querySelection({ direction, today, scope } satisfies InvoiceSelectionRequest),
        )
            .then((result) => {
                if (!cancelled) summary = result;
            })
            .catch(() => {
                if (!cancelled) summary = { count: 0, blocked: 0, unpaid: 0, totals: [] };
            });
        return () => {
            cancelled = true;
        };
    });

    // Derived before the table is constructed: TanStack reads the `data` and
    // `state` getters immediately, so these must already be initialised.
    const visibleRows = $derived(queryResult?.rows ?? []);
    const matchCount = $derived(queryResult?.matchCount ?? 0);
    const totalCount = $derived(queryResult?.totalCount ?? 0);
    const pageCount = $derived(queryResult?.pageCount ?? 1);
    const currentPage = $derived(queryResult?.page ?? page);
    const noneMatch = $derived(hasFilters && matchCount === 0);

    const selectedSet = $derived(new Set(selectedIds));
    const excludedSet = $derived(new Set(excludedIds));
    const pageSelected = $derived(visibleRows.filter((row) => isRowSelected(row.id)));
    const pageFullySelected = $derived(visibleRows.length > 0 && pageSelected.length === visibleRows.length);
    const selectionCount = $derived(allMatching ? Math.max(0, matchCount - excludedIds.length) : selectedIds.length);
    const blockedCount = $derived(summary.blocked);
    const unpaidCount = $derived(summary.unpaid);
    const partyOptions = $derived(queryResult?.parties ?? []);
    const issuedDates = $derived(queryResult?.issuedDates ?? []);
    const dueDates = $derived(queryResult?.dueDates ?? []);
    const taxPointDates = $derived(queryResult?.taxPointDates ?? []);

    const helper = createInvoiceListColumnHelper<InvoiceListRow>();
    const columns = helper.columns([
        helper.accessor('invoiceNumber', { id: 'invoiceNumber' }),
        helper.accessor('party', { id: 'party' }),
        helper.accessor('issued', { id: 'issued' }),
        helper.accessor('due', { id: 'due' }),
        helper.accessor('beforeVat', { id: 'beforeVat' }),
        helper.accessor('afterVat', { id: 'afterVat' }),
        helper.accessor('status', { id: 'status' }),
    ]);

    const table = createInvoiceListTable({
        columns,
        get data() {
            return visibleRows;
        },
        getRowId: (row) => row.id,
        get state() {
            return { sorting };
        },
        manualFiltering: true,
        manualSorting: true,
        onSortingChange: (updater) => {
            sorting = typeof updater === 'function' ? updater(sorting) : updater;
        },
        enableMultiSort: false,
    });

    function isRowSelected(id: string): boolean {
        return allMatching ? !excludedSet.has(id) : selectedSet.has(id);
    }

    function toggleRow(id: string): void {
        if (allMatching) {
            excludedIds = excludedSet.has(id)
                ? excludedIds.filter((value) => value !== id)
                : [...excludedIds, id];
            return;
        }
        selectedIds = selectedSet.has(id)
            ? selectedIds.filter((value) => value !== id)
            : [...selectedIds, id];
    }

    function togglePage(): void {
        const ids = visibleRows.map((row) => row.id);
        if (allMatching) {
            excludedIds = pageFullySelected
                ? [...new Set([...excludedIds, ...ids])]
                : excludedIds.filter((value) => !ids.includes(value));
            return;
        }
        selectedIds = pageFullySelected
            ? selectedIds.filter((value) => !ids.includes(value))
            : [...new Set([...selectedIds, ...ids])];
    }

    function selectAllMatching(): void {
        allMatching = true;
        excludedIds = [];
        selectedIds = [];
    }

    function clearSelection(): void {
        selectedIds = [];
        allMatching = false;
        excludedIds = [];
    }

    /** What a bulk action applies to, resolved in SQL rather than from the page. */
    function selectionPayload(): InvoiceSelection {
        return {
            ids: allMatching ? null : [...selectedIds],
            filters: currentFilters,
            excludedIds: allMatching ? [...excludedIds] : [],
            rows: visibleRows,
            count: selectionCount,
            pageRows: visibleRows.length,
        };
    }

    const filterChips = $derived.by(() => {
        const chips: Array<{ id: string; label: string }> = [];
        if (searchFilter.trim()) chips.push({ id: 'search', label: `Search: ${searchFilter.trim()}` });
        if (invoiceFilter.trim()) chips.push({ id: 'invoiceNumber', label: `Invoice: ${invoiceFilter.trim()}` });
        if (partyFilter.trim()) chips.push({ id: 'party', label: `${partyLabel}: ${partyFilter.trim()}` });
        if (statusFilter !== 'all') chips.push({ id: 'status', label: `Status: ${statusOptions.find((option) => option.value === statusFilter)?.label ?? statusFilter}` });
        if (typeFilter) chips.push({ id: 'expenseType', label: `Type: ${typeFilter === EXPENSE_TYPE_UNSET ? 'Not set' : expenseTypeLabel(typeFilter) || typeFilter}` });
        if (issuedRange.from || issuedRange.to) chips.push({ id: 'issued', label: `Issued: ${issuedRange.from || '…'} – ${issuedRange.to || '…'}` });
        if (dueRange.from || dueRange.to) chips.push({ id: 'due', label: `Due: ${dueRange.from || '…'} – ${dueRange.to || '…'}` });
        if (taxPointRange.from || taxPointRange.to) chips.push({ id: 'taxPoint', label: `DUZP: ${taxPointRange.from || '…'} – ${taxPointRange.to || '…'}` });
        if (beforeRange.min || beforeRange.max) chips.push({ id: 'beforeVat', label: `Before VAT: ${beforeRange.min || '…'} – ${beforeRange.max || '…'}` });
        if (afterRange.min || afterRange.max) chips.push({ id: 'afterVat', label: `After VAT: ${afterRange.min || '…'} – ${afterRange.max || '…'}` });
        return chips;
    });

    function resetFilters(): void {
        searchFilter = '';
        invoiceFilter = '';
        partyFilter = '';
        statusFilter = 'all';
        typeFilter = '';
        issuedRange = { from: '', to: '' };
        dueRange = { from: '', to: '' };
        taxPointRange = { from: '', to: '' };
        beforeRange = { min: '', max: '' };
        afterRange = { min: '', max: '' };
        page = 1;
    }

    function clearFilter(id: string): void {
        switch (id) {
            case 'search': searchFilter = ''; break;
            case 'invoiceNumber': invoiceFilter = ''; break;
            case 'party': partyFilter = ''; break;
            case 'status': statusFilter = 'all'; break;
            case 'expenseType': typeFilter = ''; break;
            case 'issued': issuedRange = { from: '', to: '' }; break;
            case 'due': dueRange = { from: '', to: '' }; break;
            case 'taxPoint': taxPointRange = { from: '', to: '' }; break;
            case 'beforeVat': beforeRange = { min: '', max: '' }; break;
            case 'afterVat': afterRange = { min: '', max: '' }; break;
        }
        page = 1;
    }

    function setStatus(value: string): void {
        statusFilter = value;
        page = 1;
    }

    function money(value: number | null, currency: string): string {
        if (value === null) return '—';
        try {
            return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency }).format(value);
        } catch {
            return `${new Intl.NumberFormat('cs-CZ').format(value)} ${currency}`;
        }
    }

    async function markSelectedPaid(): Promise<void> {
        if (markingPaid || blockedCount > 0 || unpaidCount === 0) return;
        markingPaid = true;
        try {
            if (await onMarkPaid(selectionPayload())) clearSelection();
        } finally {
            markingPaid = false;
        }
    }

    const resultLabel = $derived(
        queryLoading
            ? 'Updating…'
            : hasFilters
              ? `${matchCount} of ${totalCount} invoice${totalCount === 1 ? '' : 's'}`
              : `${totalCount} invoice${totalCount === 1 ? '' : 's'}`,
    );
    // Phones: press and hold starts selecting; the click that ends the press is its own.
    const phone = new MediaQuery('max-width: 767px');
    let pressEnding = false;
    // Phone filters: named ranges as chips.
    let allParties = $state(false);
    let dueCustom = $state(false);
    let issuedCustom = $state(false);
    let phoneMoreFilters = $state(false);
    const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const DUE_PRESETS = [
        { value: 'overdue', label: 'Overdue' },
        { value: 'next30', label: 'Next 30 days' },
        { value: 'month', label: 'This month' },
    ];
    const ISSUED_PRESETS = [
        { value: 'quarter', label: 'This quarter' },
        { value: 'year', label: 'This year' },
        { value: 'lastYear', label: 'Last year' },
    ];
    function presetRange(preset: string): DateRange {
        const now = new Date(`${today}T12:00:00`);
        const y = now.getFullYear();
        const m = now.getMonth();
        switch (preset) {
            case 'next30': { const end = new Date(now); end.setDate(end.getDate() + 30); return { from: today, to: iso(end) }; }
            case 'month': return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
            case 'quarter': { const q = Math.floor(m / 3) * 3; return { from: iso(new Date(y, q, 1)), to: iso(new Date(y, q + 3, 0)) }; }
            case 'year': return { from: `${y}-01-01`, to: `${y}-12-31` };
            case 'lastYear': return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
            default: return { from: '', to: '' };
        }
    }
    const sameRange = (a: DateRange, b: DateRange) => a.from === b.from && a.to === b.to;
    const duePreset = $derived(statusFilter === 'overdue' ? 'overdue' : DUE_PRESETS.find((preset) => preset.value !== 'overdue' && sameRange(presetRange(preset.value), dueRange))?.value ?? null);
    const issuedPreset = $derived(ISSUED_PRESETS.find((preset) => sameRange(presetRange(preset.value), issuedRange))?.value ?? null);
    function setDuePreset(value: string): void {
        if (value === duePreset) { if (value === 'overdue') statusFilter = 'all'; else dueRange = { from: '', to: '' }; page = 1; return; }
        if (value === 'overdue') { statusFilter = 'overdue'; dueRange = { from: '', to: '' }; }
        else { if (statusFilter === 'overdue') statusFilter = 'all'; dueRange = presetRange(value); }
        page = 1;
    }
    function setIssuedPreset(value: string): void {
        issuedRange = value === issuedPreset ? { from: '', to: '' } : presetRange(value);
        page = 1;
    }

    /** Select in the options starts selecting before anything is ticked. */
    let selectMode = $state(false);
    let optionsOpen = $state(false);
    const selectingNow = $derived(selectionCount > 0 || selectMode);
    function selectingClick(event: MouseEvent): void {
        if (pressEnding) { pressEnding = false; return; }
        if (!phone.current || !selectingNow) return;
        const target = event.target as HTMLElement;
        const row = target.closest<HTMLElement>('[data-invoice-row]');
        if (!row || target.closest('[data-row-check]')) return;
        event.preventDefault();
        event.stopPropagation();
        toggleRow(row.dataset.invoiceRow ?? '');
    }

    // While selecting on a phone the top bar names the count, with Select all and Cancel.
    $effect(() => {
        if (!phone.current || !selectingNow) return;
        phoneHeader.selection = {
            label: selectionCount === 0 ? "Select" : `${selectionCount} selected`,
            onSelectAll: allMatching ? undefined : selectAllMatching,
            onCancel: () => { selectMode = false; clearSelection(); },
        };
        return () => { phoneHeader.selection = null; };
    });

    const PHONE_SORTS = [
        { id: 'issued', label: 'Issued' },
        { id: 'due', label: 'Due' },
        { id: 'afterVat', label: 'Total payable' },
        { id: 'beforeVat', label: 'Before VAT' },
        { id: 'party', label: 'Party' },
        { id: 'invoiceNumber', label: 'Number' },
        { id: 'status', label: 'Status' },
    ];
    /** Picking a field starts it in its natural direction: newest and largest first, names A to Z. */
    function setSort(id: string): void {
        if (id === currentSort.id) return;
        sorting = [{ id, desc: !['party', 'invoiceNumber', 'status', 'due'].includes(id) }];
        page = 1;
    }
    const statusChips = $derived([{ value: 'all', label: 'All' }, ...statusOptions.filter((option) => option.value !== 'all')]);
</script>

{#snippet sortHeader(id: string, label: string)}
    <button type="button" class="inline-flex items-center gap-1 font-[inherit] [text-transform:inherit] hover:text-[var(--stor-accent-strong)] focus-visible:outline-2 focus-visible:outline-[var(--stor-focus)]"
        onclick={() => table.getColumn(id)?.toggleSorting()} aria-label={`Sort by ${label}`}>
        {label}
        {#if sorting[0]?.id === id}
            {#if sorting[0].desc}<IconArrowDown class="h-3.5 w-3.5" />{:else}<IconArrowUp class="h-3.5 w-3.5" />{/if}
        {:else}<IconUnfoldMore class="h-3.5 w-3.5 opacity-50" />{/if}
    </button>
{/snippet}

<section class="stor-invoice-toolbar space-y-2 p-3 max-md:p-0" aria-label={`${tableLabel} filters`}>
    <div class="stor-invoice-toolbar-main flex flex-wrap items-center gap-2 max-md:flex-nowrap max-md:has-[button:not([data-options-fab])]:p-2">
        <span class="mr-auto text-sm font-medium text-[var(--stor-ink)] max-md:sr-only" role="status" aria-live="polite">{resultLabel}</span>
        {#if overdueCount > 0 && statusFilter !== 'overdue'}
            <!-- Phones carry this in the Overdue chip and the top bar's figure. -->
            <button type="button" class="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--stor-negative-soft)] px-3 text-xs font-semibold text-[var(--stor-negative)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] max-md:hidden" data-testid="overdue-banner" onclick={() => setStatus('overdue')}>
                <span class="h-1.5 w-1.5 rounded-full bg-[var(--stor-negative)]" aria-hidden="true"></span>{overdueCount} overdue
            </button>
        {/if}
        {@render toolbar?.()}
    {#if !phone.current}
    <div bind:this={statusRow} class="stor-invoice-status-filters stor-segmented-control mobile-scroll flex min-w-0 max-w-full items-center overflow-x-auto max-md:ml-0 max-md:flex-1" aria-label="Quick status filters" style:order={phone.current ? 0 : undefined}>
        {#each statusChips as option (option.value)}
            <button
                type="button"
                aria-pressed={statusFilter === option.value}
                onclick={() => setStatus(option.value)}
                class="stor-segmented-option shrink-0 whitespace-nowrap transition focus-visible:outline-2 focus-visible:outline-[var(--stor-focus)]"
            >
                {option.label}
                {#if queryResult?.statusCounts[option.value] !== undefined}<span class="stor-tab-count ml-1.5">{queryResult.statusCounts[option.value]}</span>{/if}
            </button>
        {/each}
    </div>
    {/if}
        <button type="button" style:order={phone.current ? 9 : undefined} onclick={() => { if (phone.current) optionsOpen = true; else filtersOpen = true; }}
            aria-label={phone.current ? "List options" : "Filters"}
            class="inline-flex h-10 items-center gap-2 rounded-lg border border-[var(--stor-border)] bg-[var(--stor-surface-raised)] px-3 text-sm font-semibold text-[var(--stor-ink)] shadow-[var(--stor-shadow-sm)] transition hover:bg-[var(--stor-surface-muted)] focus-visible:outline-2 focus-visible:outline-[var(--stor-focus)]"
            class:stor-mobile-fab={phone.current}
            data-options-fab
        >
            <IconFilter class="h-4 w-4" />
            <span class="max-md:sr-only">Filters</span>
            {#if filterChips.length}<span class="rounded-full bg-[var(--stor-accent-soft)] px-1.5 text-xs text-[var(--stor-accent-strong)]">{filterChips.length}</span>{/if}
        </button>
    </div>
    {#if filterChips.length}
        <div class="flex flex-wrap gap-1.5 max-md:px-2 max-md:pb-2" aria-label="Active filters">
            {#each filterChips as chip (chip.id)}
                <button type="button" aria-label={`Remove ${chip.id} filter`} onclick={() => clearFilter(chip.id)} class="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full bg-[var(--stor-accent-soft)] px-2.5 text-xs font-medium text-[var(--stor-accent-strong)] transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-[var(--stor-focus)]">
                    <span class="truncate">{chip.label}</span><IconClose class="h-3.5 w-3.5 shrink-0" />
                </button>
            {/each}
            <button type="button" onclick={resetFilters} class="min-h-8 px-2 text-xs font-semibold text-[var(--stor-muted-text)] hover:text-[var(--stor-ink)]">Clear all</button>
        </div>
    {/if}
</section>

<Drawer show={filtersOpen} title="Filters and sort" size="lg" onClose={() => filtersOpen = false}>
        <!-- The search, then status, sort and the ranges you use as chips; the rest folds. -->
        <div class="flex flex-col gap-4">
            <input type="search" aria-label="Search invoices" placeholder={`Number or ${partyLabel.toLocaleLowerCase()}`} value={searchFilter}
                oninput={(event) => { searchFilter = event.currentTarget.value; page = 1; }}
                class="h-11 w-full rounded-xl border border-[var(--stor-field-border)] bg-[var(--stor-surface-well)] px-3 text-base text-[var(--stor-ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-selected)]" />
            <div class="flex flex-col gap-1.5">
                <span class="text-sm font-medium text-[var(--stor-ink)]">Status</span>
                <ChoiceChips label="Status" options={statusChips.map((option) => ({ value: option.value, label: option.value === 'overdue' && overdueCount > 0 ? `${option.label} · ${overdueCount}` : option.label }))} value={statusFilter} onChange={(value) => setStatus(value)} />
            </div>
            <div class="flex flex-col gap-1.5">
                <span class="text-sm font-medium text-[var(--stor-ink)]">Sort by</span>
                <ChoiceChips label="Sort by" options={PHONE_SORTS.map((option) => ({ value: option.id, label: option.id === 'party' ? partyLabel : option.label }))} value={currentSort.id} onChange={(value) => setSort(value)} />
                <ChoiceChips label="Sort direction" options={[{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }]} value={currentSort.desc ? 'desc' : 'asc'} onChange={(value) => { sorting = [{ id: currentSort.id, desc: value === 'desc' }]; page = 1; }} />
            </div>
            <div class="flex flex-col gap-1.5">
                <span class="text-sm font-medium text-[var(--stor-ink)]">{partyLabel}</span>
                <ChoiceChips label={partyLabel} options={(allParties ? partyOptions : partyOptions.slice(0, 3)).map((party) => ({ value: party, label: party }))} value={partyFilter} onChange={(value) => { partyFilter = partyFilter === value ? '' : value; page = 1; }} more={!allParties && partyOptions.length > 3 ? 'All' : undefined} onMore={() => (allParties = true)} />
            </div>
            <div class="flex flex-col gap-1.5">
                <span class="text-sm font-medium text-[var(--stor-ink)]">Due</span>
                <ChoiceChips label="Due" options={DUE_PRESETS} value={duePreset} onChange={(value) => setDuePreset(value)} more="Pick" onMore={() => (dueCustom = !dueCustom)} moreActive={dueCustom} />
                {#if dueCustom}<InvoiceDateRange label="Due date" idPrefix={`${direction}-due-phone`} dates={dueDates} bind:range={dueRange} />{/if}
            </div>
            <div class="flex flex-col gap-1.5">
                <span class="text-sm font-medium text-[var(--stor-ink)]">Issued</span>
                <ChoiceChips label="Issued" options={ISSUED_PRESETS} value={issuedPreset} onChange={(value) => setIssuedPreset(value)} more="Pick" onMore={() => (issuedCustom = !issuedCustom)} moreActive={issuedCustom} />
                {#if issuedCustom}<InvoiceDateRange label="Issued date" idPrefix={`${direction}-issued-phone`} dates={issuedDates} bind:range={issuedRange} />{/if}
            </div>
            <FoldLine bind:open={phoneMoreFilters} tone="link" summary={showExpenseType ? "Expense type, amount, tax point" : "Amount, tax point"}>
                {#if showExpenseType}
                    <label class="text-xs font-medium text-[var(--stor-muted-text)]">Expense type
                        <Select ariaLabel="Filter expense type" value={typeFilter} options={[{ value: '', label: 'All types' }, { value: EXPENSE_TYPE_UNSET, label: 'Not set' }, ...EXPENSE_TYPES.map((type) => ({ value: type.value, label: type.label }))]} onValueChange={(value) => { typeFilter = value; page = 1; }} class="mt-1" />
                    </label>
                {/if}
                <InvoiceAmountRange label="Before VAT" bounds={queryResult?.beforeBounds ?? null} bind:range={beforeRange} />
                <InvoiceAmountRange label="After VAT" bounds={queryResult?.afterBounds ?? null} bind:range={afterRange} />
                <InvoiceDateRange label="Tax point (DUZP)" idPrefix={`${direction}-taxpoint-phone`} dates={taxPointDates} bind:range={taxPointRange} />
            </FoldLine>
        </div>
    {#snippet footer()}
        <button type="button" disabled={!filterChips.length} onclick={resetFilters} class="h-10 px-3 text-sm font-semibold text-[var(--stor-accent-strong)] disabled:opacity-40">Clear all</button>
        <button type="button" onclick={() => { filtersOpen = false; optionsOpen = false; }} class="h-10 rounded-lg bg-[var(--stor-accent-strong)] px-4 text-sm font-semibold text-white max-md:h-12 max-md:flex-1 max-md:rounded-xl">{queryLoading ? 'Updating…' : `Show ${matchCount} invoice${matchCount === 1 ? '' : 's'}`}</button>
    {/snippet}
</Drawer>

<!-- Phones: the list's options in one sheet: the filters, Select, and Import where there is one. -->
<Modal show={optionsOpen} title={`${tableLabel} options`} onClose={() => (optionsOpen = false)}>
    <div class="flex flex-col divide-y divide-[color-mix(in_srgb,var(--stor-border)_62%,transparent)]">
        <button type="button" class="flex min-h-16 items-center gap-3 text-left" onclick={() => (filtersOpen = true)}>
            <span class="min-w-0 flex-1"><span class="block text-[15px] font-medium text-[var(--stor-ink)]">Filters and sort</span><span class="block text-[12.5px] text-[var(--stor-muted-text)]">{filterChips.length ? `${filterChips.length} on` : `Status, ${partyLabel.toLocaleLowerCase()}, dates and amounts`}</span></span>
            <IconChevronRight class="h-5 w-5 shrink-0 text-[var(--stor-muted-text)]" />
        </button>
        <CommandOnly>
            <button type="button" class="flex min-h-16 w-full items-center gap-3 text-left" onclick={() => { optionsOpen = false; selectMode = true; }}>
                <span class="min-w-0 flex-1"><span class="block text-[15px] font-medium text-[var(--stor-ink)]">Select {tableLabel.toLocaleLowerCase()}</span><span class="block text-[12.5px] text-[var(--stor-muted-text)]">Mark paid or delete several. Or press and hold a row.</span></span>
                <IconChevronRight class="h-5 w-5 shrink-0 text-[var(--stor-muted-text)]" />
            </button>
            {#if onImport}
                <button type="button" class="flex min-h-16 w-full items-center gap-3 text-left" onclick={() => { optionsOpen = false; onImport?.(); }}>
                    <span class="min-w-0 flex-1"><span class="block text-[15px] font-medium text-[var(--stor-ink)]">Import invoice</span><span class="block text-[12.5px] text-[var(--stor-muted-text)]">From a PDF or ISDOC file</span></span>
                    <IconChevronRight class="h-5 w-5 shrink-0 text-[var(--stor-muted-text)]" />
                </button>
            {/if}
        </CommandOnly>
    </div>
</Modal>

{#if selectionCount}
    {#if allMatching || pageFullySelected && matchCount > visibleRows.length}
        <div
            class="flex flex-wrap items-center gap-x-3 gap-y-1 bg-[var(--stor-surface-muted)] px-4 py-2 text-xs text-[var(--stor-muted-text)]"
            role="status"
        >
            {#if allMatching}
                <span>All {selectionCount} invoice{selectionCount === 1 ? '' : 's'} matching these filters are selected.</span>
                <button type="button" onclick={clearSelection} class="font-semibold text-[var(--stor-accent-strong)] hover:underline">Clear selection</button>
            {:else}
                <span>All {visibleRows.length} rows on this page are selected.</span>
                <button type="button" onclick={selectAllMatching} class="font-semibold text-[var(--stor-accent-strong)] hover:underline">Select all {matchCount} matching these filters</button>
            {/if}
        </div>
    {/if}
    <div class="sticky top-0 z-10 hidden flex-wrap items-center gap-x-6 gap-y-2 bg-[var(--stor-accent-soft)] px-4 py-3 text-sm lg:flex" aria-label="Selected invoice totals">
        <strong>{selectionCount} selected</strong>
        {#if queryLoading}<span class="text-[var(--stor-muted-text)]">Calculating totals…</span>{/if}
        {#each queryLoading ? [] : summary.totals as totals}
            <div><span class="text-[var(--stor-muted-text)]">Before VAT</span> <strong class="ml-1 tabular-nums">{money(totals.knownBefore ? totals.before : null, totals.currency)}</strong>{#if totals.missingBefore}<span class="ml-1 text-xs">({totals.missingBefore} unavailable)</span>{/if}</div>
            <div><span class="text-[var(--stor-muted-text)]">After VAT</span> <strong class="ml-1 tabular-nums">{money(totals.knownAfter ? totals.after : null, totals.currency)}</strong>{#if totals.missingAfter}<span class="ml-1 text-xs">({totals.missingAfter} unavailable)</span>{/if}</div>
        {/each}
        <div class="ml-auto flex items-center gap-2">
            <CommandOnly><button type="button" disabled={markingPaid || blockedCount > 0 || unpaidCount === 0} title={blockedCount ? `${blockedCount} selected invoice(s) need review` : undefined} onclick={markSelectedPaid} class="h-9 rounded-lg bg-[var(--stor-accent-strong)] px-3 font-semibold text-white disabled:opacity-50">Mark paid</button>
            <button type="button" onclick={() => onDelete(selectionPayload())} class="h-9 rounded-lg px-3 font-semibold text-[var(--stor-negative)]">Delete</button></CommandOnly>
            <button type="button" onclick={clearSelection} class="h-9 px-2 text-[var(--stor-accent-strong)]">Clear selection</button>
        </div>
        {#if blockedCount}<p class="w-full text-xs">{blockedCount} selected invoice(s) need review before they can be marked paid.</p>{/if}
    </div>
{/if}

{#snippet invoiceIllustration()}
    <svg viewBox="0 0 120 84" class="h-[84px] w-[120px]" aria-hidden="true">
        <rect x="18" y="14" width="64" height="64" rx="8" fill="var(--stor-surface-muted)" stroke="var(--stor-border-strong)" stroke-width="1.5" />
        <rect x="38" y="6" width="64" height="64" rx="8" fill="var(--stor-surface)" stroke="var(--stor-muted-text)" stroke-width="1.5" />
        <path d="M50 24h40M50 34h28M50 50h16" stroke="var(--stor-faint-text)" stroke-width="1.5" stroke-linecap="round" fill="none" />
        <path d="M76 50h14" stroke="var(--stor-accent-strong)" stroke-width="2.5" stroke-linecap="round" fill="none" />
        <circle cx="96" cy="66" r="11" fill="var(--stor-accent)" />
        <path d="M96 61v10M91 66h10" stroke="var(--stor-action-text, #fff)" stroke-width="2" stroke-linecap="round" fill="none" />
    </svg>
{/snippet}

{#if loading || !queryResult && !queryError}
    <div class="p-4 text-sm text-[var(--stor-muted-text)]">Loading invoices…</div>
{:else if queryError}
    <div class="flex items-center gap-3 p-4 text-sm text-[var(--stor-negative)]" role="alert">Could not load invoices. <button type="button" class="font-semibold underline" onclick={() => queryNonce += 1}>Retry</button></div>
{:else if visibleRows.length === 0}
    <EmptyState title={noneMatch ? 'No invoices match these filters' : emptyTitle}
        description={noneMatch ? 'Adjust or clear the column filters.' : emptyDescription} surface={false}
        illustration={!noneMatch && totalCount === 0 ? invoiceIllustration : undefined}>
        {#if hasFilters}
            <Button variant="secondary" onclick={resetFilters}>Clear filters</Button>
        {/if}
        {#if !hasFilters && totalCount === 0 && onCreate}
            <CommandOnly>
                <Button onclick={onCreate}>{createLabel}</Button>
                {#if onImport}<Button variant="secondary" onclick={onImport}>Import PDF</Button>{/if}
            </CommandOnly>
        {/if}
    </EmptyState>
{:else}
    <div class="hidden max-w-full overflow-x-auto lg:block">
        <table class="w-full {showExpenseType ? 'min-w-[66rem]' : 'min-w-[56rem]'} table-fixed border-collapse text-left text-sm" aria-label={tableLabel}>
            <!-- Fixed widths so the issued and received tables line up exactly. -->
            <colgroup>
                <col class="w-10" />
                <col />
                <col class="w-28" />
                <col class="w-28" />
                <col class="w-36" />
                <col class="w-36" />
                {#if showExpenseType}<col class="w-36" />{/if}
                <col class="w-28" />
                <col class="w-20" />
            </colgroup>
            <thead class="stor-overline">
                <tr>
                    <th scope="col" class="border-b border-[var(--stor-border-strong)] px-3 pb-2 pt-0 align-bottom"><input type="checkbox" aria-label="Select all filtered invoices" checked={pageFullySelected} indeterminate={pageSelected.length > 0 && !pageFullySelected} onchange={togglePage} /></th>
                    <th scope="col" class="border-b border-[var(--stor-border-strong)] px-3 pb-2 pt-0 align-bottom" aria-sort={sorting[0]?.id === 'party' || sorting[0]?.id === 'invoiceNumber' ? sorting[0].desc ? 'descending' : 'ascending' : 'none'}>
                        <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
                            {@render sortHeader('party', partyLabel)}
                            <span class="text-[var(--stor-border-strong)]" aria-hidden="true">/</span>
                            {@render sortHeader('invoiceNumber', 'Invoice')}
                        </span>
                    </th>
                    <th scope="col" class="border-b border-[var(--stor-border-strong)] px-3 pb-2 pt-0 align-bottom" aria-sort={sorting[0]?.id === 'issued' ? sorting[0].desc ? 'descending' : 'ascending' : 'none'}>{@render sortHeader('issued', 'Issued')}</th>
                    <th scope="col" class="border-b border-[var(--stor-border-strong)] px-3 pb-2 pt-0 align-bottom" aria-sort={sorting[0]?.id === 'due' ? sorting[0].desc ? 'descending' : 'ascending' : 'none'}>{@render sortHeader('due', 'Due')}</th>
                    <th scope="col" class="border-b border-[var(--stor-border-strong)] px-3 pb-2 pt-0 align-bottom text-right" aria-sort={sorting[0]?.id === 'beforeVat' ? sorting[0].desc ? 'descending' : 'ascending' : 'none'}>{@render sortHeader('beforeVat', 'Before VAT')}</th>
                    <th scope="col" class="border-b border-[var(--stor-border-strong)] px-3 pb-2 pt-0 align-bottom text-right" aria-sort={sorting[0]?.id === 'afterVat' ? sorting[0].desc ? 'descending' : 'ascending' : 'none'}>{@render sortHeader('afterVat', 'Total payable')}</th>
                    {#if showExpenseType}<th scope="col" class="border-b border-[var(--stor-border-strong)] px-3 pb-2 pt-0 align-bottom">Type</th>{/if}
                    <th scope="col" class="border-b border-[var(--stor-border-strong)] px-3 pb-2 pt-0 align-bottom" aria-sort={sorting[0]?.id === 'status' ? sorting[0].desc ? 'descending' : 'ascending' : 'none'}>{@render sortHeader('status', 'Status')}</th>
                    <th scope="col" class="border-b border-[var(--stor-border-strong)] px-3 pb-2 pt-0 align-bottom text-right">Actions</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-[color-mix(in_srgb,var(--stor-border)_55%,transparent)]">
                {#each visibleRows as row (row.id)}
                    <tr class="group h-14 transition-colors hover:bg-[var(--stor-surface-muted)]/70 {isRowSelected(row.id) || activeId === row.id ? 'bg-[var(--stor-accent-soft)]' : ''}">
                        <td class="px-3 py-2"><input type="checkbox" aria-label={`Select invoice ${row.invoiceNumber}`} checked={isRowSelected(row.id)} onchange={() => toggleRow(row.id)} /></td>
                        <td class="max-w-[18rem] px-3 py-2"><button type="button" data-invoice-open={row.id} aria-current={activeId === row.id ? 'true' : undefined} aria-label={`${tableLabel === 'Invoices' ? 'View invoice' : 'View received invoice'} ${row.invoiceNumber}`} onclick={() => onSelect(row)} class="block max-w-full text-left hover:underline">{#if row.party}<span class="block truncate font-semibold text-[var(--stor-ink)]">{row.party}</span><span class="mt-0.5 block truncate text-xs tabular-nums text-[var(--stor-muted-text)]">{row.invoiceNumber}</span>{:else}<span class="block truncate font-semibold tabular-nums text-[var(--stor-ink)]">{row.invoiceNumber}</span><span class="mt-0.5 block truncate text-xs text-[var(--stor-muted-text)]">No {partyLabel.toLocaleLowerCase()}</span>{/if}</button>{#if row.storageStatus !== null && storageLabel}<span class="block text-xs text-[var(--stor-muted-text)]">{storageLabel(row.storageStatus)}</span>{/if}</td>
                        <td class="whitespace-nowrap px-3 py-2 tabular-nums">{formatInvoiceDate(row.issued)}</td>
                        <td class="whitespace-nowrap px-3 py-2 tabular-nums">{formatInvoiceDate(row.due)}</td>
                        <td class="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(row.beforeVat, row.currency)}</td>
                        <td class="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums">{money(row.afterVat, row.currency)}</td>
                        {#if showExpenseType}<td class="truncate px-3 py-2 text-xs text-[var(--stor-muted-text)]">{expenseTypeLabel(row.expenseType) || '—'}</td>{/if}
                        <td class="px-3 py-2">{@render statusBadge(row)}</td>
                        <td class="px-3 py-2 text-right"><div class="flex justify-end opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">{@render actions(row)}</div></td>
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
    <!-- Below 768 px rows have no checkbox until press and hold; while selecting, a tap ticks the row. -->
    <div
        class="divide-y divide-[var(--stor-border)] {selectionCount ? 'pb-44' : ''} lg:hidden"
        data-invoice-phone-list
        data-selecting={selectingNow ? 'true' : 'false'}
        use:longPress={{ selector: '[data-invoice-row]', onLongPress: (element) => { pressEnding = true; setTimeout(() => (pressEnding = false), 800); toggleRow(element.dataset.invoiceRow ?? ''); } }}
        onclickcapture={selectingClick}
    >
        {#each visibleRows as row (row.id)}
            <article data-invoice-row={row.id} class="flex min-h-16 items-center gap-3 px-3 py-2.5 {isRowSelected(row.id) || activeId === row.id ? 'bg-[var(--stor-accent-soft)]' : ''}">
                <input type="checkbox" aria-label={`Select invoice ${row.invoiceNumber}`} checked={isRowSelected(row.id)} onchange={() => toggleRow(row.id)} class="h-5 w-5 shrink-0" data-row-check />
                <button type="button" data-invoice-open={row.id} aria-current={activeId === row.id ? 'true' : undefined} aria-label={tableLabel === 'Invoices' ? `View invoice ${row.invoiceNumber}` : row.invoiceNumber} onclick={() => onSelect(row)} class="min-w-0 flex-1 text-left">
                    <span class="flex items-center justify-between gap-2"><strong class="truncate text-sm {row.party ? '' : 'tabular-nums'}">{row.party || row.invoiceNumber}</strong><strong class="whitespace-nowrap text-sm tabular-nums">{money(row.afterVat, row.currency)}</strong></span>
                    <span class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--stor-muted-text)]">{#if row.party}<span class="tabular-nums">{row.invoiceNumber}</span>{:else}<span>No {partyLabel.toLocaleLowerCase()}</span>{/if}<span>Due {formatInvoiceDate(row.due)}</span>{#if showExpenseType && row.expenseType}<span>{expenseTypeLabel(row.expenseType)}</span>{/if}{@render statusBadge(row)}</span>
                    {#if row.storageStatus !== null && storageLabel}<span class="mt-1 block text-xs text-[var(--stor-muted-text)]">{storageLabel(row.storageStatus)}</span>{/if}
                </button>
            </article>
        {/each}
    </div>
    {#if pageCount > 1}
        <nav class="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--stor-border)] p-3 text-sm" aria-label="Invoice pages">
            <span class="text-xs text-[var(--stor-muted-text)]">Page {currentPage} of {pageCount} · {matchCount} matching</span>
            <div class="flex items-center gap-2">
                <button type="button" disabled={currentPage <= 1} onclick={() => page = Math.max(1, currentPage - 1)} class="h-9 rounded-lg border border-[var(--stor-border)] px-3 font-semibold text-[var(--stor-ink)] disabled:opacity-40">Previous</button>
                <button type="button" disabled={currentPage >= pageCount} onclick={() => page = Math.min(pageCount, currentPage + 1)} class="h-9 rounded-lg border border-[var(--stor-border)] px-3 font-semibold text-[var(--stor-ink)] disabled:opacity-40">Next</button>
            </div>
        </nav>
    {/if}
{/if}

{#if selectionCount}
    <div class="fixed inset-x-2 bottom-[calc(var(--stor-mobile-bottom-inset)+var(--stor-mobile-nav-height)+2*var(--stor-mobile-stack-gap)+var(--stor-mobile-action-height))] z-30 rounded-xl bg-[var(--stor-surface)] p-3 shadow-[var(--stor-elevation-3)] lg:hidden" aria-label="Selected invoice totals">
        <div class="flex items-center justify-between"><strong>{selectionCount} selected</strong><button type="button" onclick={() => { selectMode = false; clearSelection(); }} class="min-h-11 text-sm text-[var(--stor-accent-strong)]">Cancel</button></div>
        {#if queryLoading}<span class="mt-2 block text-sm text-[var(--stor-muted-text)]">Calculating totals…</span>{/if}
        {#each queryLoading ? [] : summary.totals as totals}
            <div class="mt-2 grid grid-cols-2 gap-3 text-sm"><div><span class="block text-xs text-[var(--stor-muted-text)]">Before VAT</span><strong class="tabular-nums">{money(totals.knownBefore ? totals.before : null, totals.currency)}</strong>{#if totals.missingBefore}<span class="block text-xs">{totals.missingBefore} unavailable</span>{/if}</div><div><span class="block text-xs text-[var(--stor-muted-text)]">After VAT</span><strong class="tabular-nums">{money(totals.knownAfter ? totals.after : null, totals.currency)}</strong>{#if totals.missingAfter}<span class="block text-xs">{totals.missingAfter} unavailable</span>{/if}</div></div>
        {/each}
        {#if blockedCount}<p class="mt-2 text-xs">{blockedCount} selected invoice(s) need review before marking paid.</p>{/if}
        <CommandOnly><div class="mt-3 grid grid-cols-2 gap-2"><button type="button" disabled={markingPaid || blockedCount > 0 || unpaidCount === 0} onclick={markSelectedPaid} class="h-11 rounded-lg bg-[var(--stor-accent-strong)] font-semibold text-white disabled:opacity-50">Mark paid</button><button type="button" onclick={() => onDelete(selectionPayload())} class="h-11 rounded-lg bg-[var(--stor-negative-soft)] font-semibold text-[var(--stor-negative)]">Delete</button></div></CommandOnly>
    </div>
{/if}
