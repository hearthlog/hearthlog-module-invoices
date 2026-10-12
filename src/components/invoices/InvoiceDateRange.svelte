<script lang="ts">
    import { DatePicker } from "@hearthlog/sdk/ui";
    import { formatInvoiceDate } from '../../invoices/format.js';
    import type { DateRange } from '../../invoices/list-contracts.js';

    let {
        label,
        idPrefix,
        dates,
        range = $bindable(),
    }: {
        label: string;
        idPrefix: string;
        dates: string[];
        range: DateRange;
    } = $props();

    const first = $derived(dates[0] ?? '');
    const last = $derived(dates.at(-1) ?? '');
    const fromValue = $derived(range.from || first);
    const toValue = $derived(range.to || last);
    const narrowed = $derived(Boolean(range.from || range.to));

    function setFrom(value: string): void {
        const from = value === first ? '' : value;
        const effectiveTo = range.to || last;
        range = { from, to: value && effectiveTo && value > effectiveTo ? value : range.to };
    }

    function setTo(value: string): void {
        const to = value === last ? '' : value;
        const effectiveFrom = range.from || first;
        range = { from: value && effectiveFrom && value < effectiveFrom ? value : range.from, to };
    }
</script>

<div class="rounded-xl bg-[var(--stor-surface-muted)] p-3">
    <div class="flex items-start justify-between gap-3">
        <div>
            <h3 class="text-sm font-semibold text-[var(--stor-ink)]">{label}</h3>
            <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                {first ? `Available: ${formatInvoiceDate(first)} – ${formatInvoiceDate(last)}` : 'No dates on these invoices'}
            </p>
        </div>
        {#if narrowed}
            <button type="button" onclick={() => range = { from: '', to: '' }} class="shrink-0 text-xs font-semibold text-[var(--stor-accent-strong)] hover:underline">Full range</button>
        {/if}
    </div>
    <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
            <label for={`${idPrefix}-from`} class="block text-xs font-medium text-[var(--stor-muted-text)]">From</label>
            <DatePicker id={`${idPrefix}-from`} value={fromValue} onValueChange={setFrom} placeholder={`${label} from`} disabled={!first} clearable={false} class="mt-1 bg-[var(--stor-surface)]" />
        </div>
        <div>
            <label for={`${idPrefix}-to`} class="block text-xs font-medium text-[var(--stor-muted-text)]">To</label>
            <DatePicker id={`${idPrefix}-to`} value={toValue} onValueChange={setTo} placeholder={`${label} to`} disabled={!last} clearable={false} class="mt-1 bg-[var(--stor-surface)]" />
        </div>
    </div>
</div>
