<script lang="ts">
    import { Slider } from 'bits-ui';
    import type { NumberRange } from '../../invoices/list-contracts.js';

    let {
        label,
        bounds,
        range = $bindable(),
    }: {
        label: string;
        bounds: { min: number; max: number } | null;
        range: NumberRange;
    } = $props();

    function niceStep(target: number): number {
        if (!Number.isFinite(target) || target <= 0) return 0.01;
        const scale = 10 ** Math.floor(Math.log10(target));
        const units = target / scale;
        return Math.max(0.01, (units <= 1 ? 1 : units <= 2 ? 2 : units <= 5 ? 5 : 10) * scale);
    }

    const formatAmount = (value: number) => new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 }).format(value);

    const domain = $derived.by(() => {
        if (!bounds) return null;
        if (bounds.min < bounds.max) {
            return { min: bounds.min, max: bounds.max, expanded: false };
        }
        const padding = niceStep(Math.max(Math.abs(bounds.min) / 4, 1));
        return {
            min: Number((bounds.min - padding).toFixed(2)),
            max: Number((bounds.max + padding).toFixed(2)),
            expanded: true,
        };
    });

    const steps = $derived.by(() => {
        if (!domain) return [];
        const span = domain.max - domain.min;
        const count = Math.min(100, Math.max(1, Math.ceil(span / 0.01)));
        const points = Array.from({ length: count + 1 }, (_, index) => {
            if (index === 0) return domain.min;
            if (index === count) return domain.max;
            return Number((domain.min + span * index / count).toFixed(2));
        });
        for (const raw of [range.min, range.max]) {
            if (raw === '') continue;
            const value = Number(raw);
            if (Number.isFinite(value) && value >= domain.min && value <= domain.max) points.push(value);
        }
        return [...new Set(points)].sort((a, b) => a - b);
    });

    const sliderValues = $derived.by(() => {
        if (!domain) return [0, 0];
        const lower = range.min === '' ? domain.min : Number(range.min);
        const upper = range.max === '' ? domain.max : Number(range.max);
        return [
            Math.max(domain.min, Math.min(domain.max, Number.isFinite(lower) ? lower : domain.min)),
            Math.max(domain.min, Math.min(domain.max, Number.isFinite(upper) ? upper : domain.max)),
        ];
    });

    const displayMin = $derived(domain ? range.min || String(domain.min) : '');
    const displayMax = $derived(domain ? range.max || String(domain.max) : '');
    const narrowed = $derived(Boolean(range.min || range.max));

    function setFromSlider(next: number[]): void {
        if (!domain || next.length !== 2) return;
        const lower = Number(Math.min(...next).toFixed(2));
        const upper = Number(Math.max(...next).toFixed(2));
        range = {
            min: lower <= domain.min ? '' : String(lower),
            max: upper >= domain.max ? '' : String(upper),
        };
    }
</script>

<div class="rounded-xl bg-[var(--stor-surface-muted)] p-3">
    <div class="flex items-start justify-between gap-3">
        <div>
            <h3 class="text-sm font-semibold text-[var(--stor-ink)]">{label}</h3>
            <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                {#if !bounds}No amounts on these invoices
                {:else if domain?.expanded}One recorded amount: {formatAmount(bounds.min)}. Slider range widened so you can filter it.
                {:else}Available: {formatAmount(bounds.min)} – {formatAmount(bounds.max)}{/if}
            </p>
        </div>
        {#if narrowed}
            <button type="button" onclick={() => range = { min: '', max: '' }} class="shrink-0 text-xs font-semibold text-[var(--stor-accent-strong)] hover:underline">Full range</button>
        {/if}
    </div>
    {#if domain}
        <Slider.Root
            type="multiple"
            min={domain.min}
            max={domain.max}
            step={steps}
            value={sliderValues}
            onValueChange={setFromSlider}
            class="relative mt-3 flex h-10 w-full touch-none select-none items-center"
        >
            <span class="pointer-events-none absolute inset-x-0 h-2 rounded-full bg-[var(--stor-border)]"></span>
            <Slider.Range class="pointer-events-none absolute h-2 rounded-full bg-[var(--stor-accent-strong)]" />
            <Slider.Thumb index={0} aria-label={`${label} lower handle`} class="z-10 block h-6 w-6 rounded-full border-2 border-[var(--stor-accent-strong)] bg-[var(--stor-surface-raised)] shadow-[var(--stor-shadow-sm)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]" />
            <Slider.Thumb index={1} aria-label={`${label} upper handle`} class="z-10 block h-6 w-6 rounded-full border-2 border-[var(--stor-accent-strong)] bg-[var(--stor-surface-raised)] shadow-[var(--stor-shadow-sm)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]" />
        </Slider.Root>
    {/if}
    <div class="mt-2 grid grid-cols-2 gap-3">
        <label class="text-xs font-medium text-[var(--stor-muted-text)]">Minimum
            <input type="number" step="any" aria-label={`${label} minimum`} value={displayMin} disabled={!domain}
                oninput={(event) => range = { ...range, min: event.currentTarget.value }}
                class="mt-1 h-10 w-full rounded-lg border border-[var(--stor-field-border)] bg-[var(--stor-surface)] px-3 text-sm tabular-nums text-[var(--stor-ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-selected)]" />
        </label>
        <label class="text-xs font-medium text-[var(--stor-muted-text)]">Maximum
            <input type="number" step="any" aria-label={`${label} maximum`} value={displayMax} disabled={!domain}
                oninput={(event) => range = { ...range, max: event.currentTarget.value }}
                class="mt-1 h-10 w-full rounded-lg border border-[var(--stor-field-border)] bg-[var(--stor-surface)] px-3 text-sm tabular-nums text-[var(--stor-ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-selected)]" />
        </label>
    </div>
</div>
