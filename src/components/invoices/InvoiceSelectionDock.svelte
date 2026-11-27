<script lang="ts">
    import { CommandOnly, SelectionDock } from '@hearthlog/sdk/ui';
    import IconCheck from '~icons/mdi/check';
    import IconDelete from '~icons/mdi/trash-can-outline';
    import IconAlert from '~icons/mdi/alert-outline';
    import type { InvoiceSelectionTotals } from '../../data/invoice-list.js';

    /**
     * The invoice list's selection dock: the shared glass `SelectionDock` with what an invoice selection needs,
     * the scope switch (this page or everything matching), totals before and after VAT per currency, Mark paid
     * and Delete, which asks inside the dock.
     */
    let {
        count,
        allMatching,
        pageFullySelected,
        pageRows,
        matchCount,
        excludedCount,
        totals,
        totalsLoading,
        blocked,
        unpaid,
        markingPaid,
        deleteLabel = 'Delete',
        money,
        onSelectPage,
        onSelectAll,
        onMarkPaid,
        onDelete,
        onClear,
    }: {
        count: number;
        allMatching: boolean;
        pageFullySelected: boolean;
        pageRows: number;
        matchCount: number;
        excludedCount: number;
        totals: InvoiceSelectionTotals[];
        totalsLoading: boolean;
        blocked: number;
        unpaid: number;
        markingPaid: boolean;
        deleteLabel?: string;
        money: (value: number | null, currency: string) => string;
        onSelectPage: () => void;
        onSelectAll: () => void;
        onMarkPaid: () => void;
        onDelete: () => void;
        onClear: () => void;
    } = $props();

    // The scope switch only matters when the page is fully ticked and more rows match.
    const offersScope = $derived(allMatching || (pageFullySelected && matchCount > pageRows));
    const scopeText = $derived(
        allMatching
            ? excludedCount
                ? `All matching, ${excludedCount} left out`
                : 'Everything matching these filters'
            : pageFullySelected
              ? 'Every row on this page'
              : `of ${matchCount} invoice${matchCount === 1 ? '' : 's'}`,
    );
    let confirming = $state(false);
    // Changing what the selection covers withdraws the question too, not only a new count.
    $effect(() => {
        void allMatching;
        confirming = false;
    });

    const noun = $derived(count === 1 ? 'invoice' : 'invoices');
    const markLabel = $derived(unpaid > 0 && unpaid < count ? `Mark ${unpaid} paid` : 'Mark paid');
    const markDisabled = $derived(markingPaid || blocked > 0 || unpaid === 0);
    const confirm = $derived(
        confirming
            ? {
                  title: `${deleteLabel} ${count} ${noun}?`,
                  detail: 'They leave the list. The log keeps their history.',
                  action: `${deleteLabel} ${count}`,
                  onConfirm: () => {
                      confirming = false;
                      onDelete();
                  },
              }
            : null,
    );
</script>

<SelectionDock
    {count}
    label={`${count} ${noun} selected`}
    allSelected={allMatching}
    {confirm}
    onCancelConfirm={() => (confirming = false)}
    {onClear}
>
    {#snippet scope()}{scopeText}{/snippet}
    {#snippet controls()}
        {#if offersScope}
            <div class="stor-dock-switch" role="group" aria-label="What the selection covers">
                <button type="button" aria-pressed={!allMatching} onclick={onSelectPage}>This page {pageRows}</button>
                <button type="button" aria-pressed={allMatching} onclick={onSelectAll}>All matching {matchCount}</button>
            </div>
        {/if}
    {/snippet}
    {#snippet summary()}
        {#if totalsLoading}
            <span class="text-xs text-[var(--stor-muted-text)]">Calculating totals…</span>
        {:else}
            {#each totals as sum (sum.currency)}
                <div class="stor-dock-figure">
                    <span>Before VAT</span>
                    <strong>{money(sum.knownBefore ? sum.before : null, sum.currency)}</strong>
                    {#if sum.missingBefore}<small>{sum.missingBefore} without an amount</small>{/if}
                </div>
                <div class="stor-dock-figure">
                    <span>After VAT</span>
                    <strong>{money(sum.knownAfter ? sum.after : null, sum.currency)}</strong>
                    {#if sum.missingAfter}<small>{sum.missingAfter} without an amount</small>{/if}
                </div>
            {/each}
        {/if}
    {/snippet}
    {#snippet actions()}
        {#if blocked > 0}
            <span class="stor-dock-note max-lg:hidden"><IconAlert class="h-3.5 w-3.5" />Review {blocked} first</span>
        {/if}
        <CommandOnly>
            <button
                type="button"
                class="stor-dock-action stor-dock-action-primary"
                disabled={markDisabled}
                title={blocked ? `${blocked} selected invoice(s) need review before they can be marked paid` : undefined}
                onclick={onMarkPaid}
            ><IconCheck />{markLabel}</button>
            <button type="button" class="stor-dock-action stor-dock-action-danger" onclick={() => (confirming = true)}><IconDelete />{deleteLabel}</button>
        </CommandOnly>
    {/snippet}
</SelectionDock>
