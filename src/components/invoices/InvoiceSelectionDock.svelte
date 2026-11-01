<script lang="ts">
    import { CommandOnly } from '@hearthlog/sdk/ui';
    import IconCheck from '~icons/mdi/check';
    import IconClose from '~icons/mdi/close';
    import IconDelete from '~icons/mdi/trash-can-outline';
    import IconAlert from '~icons/mdi/alert-outline';
    import { untrack } from 'svelte';
    import type { InvoiceSelectionTotals } from '../../data/invoice-list.js';

    /**
     * The floating tray that appears while rows are selected. It carries the
     * count, what the selection covers, the totals and the batch actions, so
     * the list itself stays free of selection chrome.
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
    // Deleting asks inside the tray; changing the selection withdraws the question.
    let confirming = $state(false);
    $effect(() => {
        void count;
        void allMatching;
        untrack(() => (confirming = false));
    });

    const markLabel = $derived(unpaid > 0 && unpaid < count ? `Mark ${unpaid} paid` : 'Mark paid');
    const markDisabled = $derived(markingPaid || blocked > 0 || unpaid === 0);

    const tray = 'bg-[var(--stor-ink)] text-[var(--stor-surface)]';
    const quiet = 'text-[color-mix(in_srgb,var(--stor-surface)_64%,transparent)]';
    const faint = 'text-[color-mix(in_srgb,var(--stor-surface)_46%,transparent)]';
    const fill = 'bg-[color-mix(in_srgb,var(--stor-surface)_9%,transparent)]';
    const hairline = 'bg-[color-mix(in_srgb,var(--stor-surface)_14%,transparent)]';
</script>

<div class="pointer-events-none z-30 max-lg:fixed max-lg:inset-x-2 max-lg:bottom-[calc(var(--stor-mobile-bottom-inset)+var(--stor-mobile-nav-height)+2*var(--stor-mobile-stack-gap)+var(--stor-mobile-action-height))] lg:sticky lg:bottom-5 lg:flex lg:justify-center lg:px-5 lg:pb-5 lg:pt-2">
    <div
        class="pointer-events-auto flex max-w-full flex-col gap-3.5 rounded-[26px] p-4 shadow-[var(--stor-elevation-3)] lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-1.5 lg:gap-y-2 lg:rounded-[20px] lg:p-2 {tray}"
        role="region"
        aria-label="Selected invoices"
    >
      {#if confirming}
        <div class="flex items-center gap-1" role="alertdialog" aria-label="Confirm delete">
            <span class="grid h-11 w-11 place-items-center rounded-[13px] bg-[#ff7864]/15 text-[#ff9e90]"><IconDelete class="h-5 w-5" /></span>
            <span class="flex flex-col pl-2 pr-2.5 text-[13px] leading-[18px]">
                <strong class="font-semibold">{deleteLabel} {count} {count === 1 ? 'invoice' : 'invoices'}?</strong>
                <span class="text-xs leading-4 {quiet}">They leave the list. The log keeps their history.</span>
            </span>
        </div>
        <span class="hidden flex-1 lg:block lg:min-w-8" aria-hidden="true"></span>
        <div class="flex items-center gap-1.5 lg:gap-1">
            <!-- svelte-ignore a11y_autofocus -->
            <button type="button" autofocus onclick={() => (confirming = false)} class="inline-flex h-12 flex-1 items-center justify-center rounded-[14px] px-4 text-[15px] font-semibold transition hover:bg-[color-mix(in_srgb,var(--stor-surface)_9%,transparent)] focus-visible:outline-2 focus-visible:outline-[var(--stor-surface)] lg:h-10 lg:flex-none lg:rounded-xl lg:text-[13px]">Cancel</button>
            <button type="button" onclick={() => { confirming = false; onDelete(); }} class="inline-flex h-12 flex-1 items-center justify-center rounded-[14px] bg-[#d9503f] px-4 text-[15px] font-semibold text-white transition hover:bg-[#e25b49] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--stor-surface)] lg:h-10 lg:flex-none lg:rounded-xl lg:text-[13px]">{deleteLabel} {count}</button>
        </div>
      {:else}
        <div class="flex items-center gap-1">
            <span
                class="grid h-10 min-w-10 place-items-center rounded-xl px-2.5 text-base font-bold tabular-nums tracking-tight lg:h-11 lg:min-w-11 lg:rounded-[13px] lg:text-[17px] {allMatching ? 'bg-[var(--stor-surface)] text-[var(--stor-ink)]' : 'bg-[var(--stor-accent-soft)] text-[var(--stor-accent-strong)]'}"
            >{count}</span>
            <span class="flex flex-col whitespace-nowrap pl-2 pr-2.5 text-[13px] leading-[18px]" role="status" aria-live="polite">
                <strong class="font-semibold">{count === 1 ? 'invoice' : 'invoices'} selected</strong>
                <span class="text-xs leading-4 {quiet}">{scopeText}</span>
            </span>
        </div>

        {#if offersScope}
            <div class="inline-flex gap-0.5 self-start rounded-xl p-[3px] lg:self-auto {fill}" role="group" aria-label="What the selection covers">
                <button
                    type="button"
                    aria-pressed={!allMatching}
                    onclick={onSelectPage}
                    class="h-[30px] whitespace-nowrap rounded-[9px] px-2.5 text-xs font-semibold {allMatching ? quiet : 'bg-[color-mix(in_srgb,var(--stor-surface)_16%,transparent)] text-[var(--stor-surface)]'}"
                >This page <span class="ml-0.5 font-medium {faint}">{pageRows}</span></button>
                <button
                    type="button"
                    aria-pressed={allMatching}
                    onclick={onSelectAll}
                    class="h-[30px] whitespace-nowrap rounded-[9px] px-2.5 text-xs font-semibold {allMatching ? 'bg-[color-mix(in_srgb,var(--stor-surface)_16%,transparent)] text-[var(--stor-surface)]' : quiet}"
                >All matching <span class="ml-0.5 font-medium {faint}">{matchCount}</span></button>
            </div>
        {/if}

        <span class="mx-1.5 hidden h-[30px] w-px lg:block {hairline}" aria-hidden="true"></span>

        <div class="grid grid-cols-2 gap-x-6 gap-y-2 lg:flex lg:gap-x-1.5" aria-label="Selected invoice totals">
            {#if totalsLoading}
                <span class="text-xs {quiet}">Calculating totals…</span>
            {:else}
                {#each totals as sum (sum.currency)}
                    <div class="flex flex-col whitespace-nowrap lg:px-3">
                        <span class="text-[10.5px] font-semibold uppercase leading-[14px] tracking-[0.07em] {faint}">Before VAT</span>
                        <strong class="text-lg font-semibold leading-[22px] tracking-tight tabular-nums lg:text-base">{money(sum.knownBefore ? sum.before : null, sum.currency)}</strong>
                        {#if sum.missingBefore}<span class="text-xs leading-4 text-[#f2c66f]">{sum.missingBefore} without an amount</span>{/if}
                    </div>
                    <div class="flex flex-col whitespace-nowrap lg:px-3">
                        <span class="text-[10.5px] font-semibold uppercase leading-[14px] tracking-[0.07em] {faint}">After VAT</span>
                        <strong class="text-lg font-semibold leading-[22px] tracking-tight tabular-nums lg:text-base">{money(sum.knownAfter ? sum.after : null, sum.currency)}</strong>
                        {#if sum.missingAfter}<span class="text-xs leading-4 text-[#f2c66f]">{sum.missingAfter} without an amount</span>{/if}
                    </div>
                {/each}
            {/if}
        </div>

        <span class="hidden flex-1 lg:block lg:min-w-4" aria-hidden="true"></span>

        <div class="flex items-center gap-1.5 lg:gap-1">
            {#if blocked > 0}
                <span class="hidden h-[30px] items-center gap-1.5 whitespace-nowrap rounded-[10px] bg-[#f2c66f]/15 px-2.5 text-xs font-semibold text-[#f2c66f] lg:inline-flex">
                    <IconAlert class="h-3.5 w-3.5" />Review {blocked} first
                </span>
            {/if}
            <CommandOnly>
                <button
                    type="button"
                    disabled={markDisabled}
                    title={blocked ? `${blocked} selected invoice(s) need review before they can be marked paid` : undefined}
                    onclick={onMarkPaid}
                    class="inline-flex h-12 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-[14px] bg-[var(--stor-surface)] px-3.5 text-[15px] font-semibold text-[var(--stor-ink)] shadow-[0_1px_2px_rgb(0_0_0/0.3)] transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--stor-surface)] disabled:cursor-default disabled:shadow-none disabled:hover:brightness-100 lg:h-10 lg:flex-none lg:rounded-xl lg:text-[13px] {markDisabled ? `${fill} ${faint} !bg-[color-mix(in_srgb,var(--stor-surface)_9%,transparent)]` : ''}"
                ><IconCheck class="h-4 w-4" />{markLabel}</button>
                <button
                    type="button"
                    onclick={() => (confirming = true)}
                    class="inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-[14px] bg-[#ff7864]/15 px-4 text-[15px] font-semibold text-[#ff9e90] transition hover:bg-[#ff7864]/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--stor-surface)] lg:h-10 lg:rounded-xl lg:bg-transparent lg:px-3.5 lg:text-[13px] lg:hover:bg-[#ff7864]/15"
                ><IconDelete class="h-4 w-4" />{deleteLabel}</button>
            </CommandOnly>
            <button
                type="button"
                onclick={onClear}
                aria-label="Clear selection"
                class="inline-flex h-12 items-center gap-1.5 rounded-[14px] px-3 text-sm {quiet} transition hover:bg-[color-mix(in_srgb,var(--stor-surface)_9%,transparent)] focus-visible:outline-2 focus-visible:outline-[var(--stor-surface)] lg:h-10 lg:rounded-xl lg:px-2.5"
            >
                <IconClose class="h-4 w-4" />
                <kbd class="hidden h-[18px] items-center rounded-[5px] px-1.5 font-sans text-[10.5px] font-semibold lg:inline-flex {fill}">Esc</kbd>
            </button>
        </div>
      {/if}
    </div>
</div>
