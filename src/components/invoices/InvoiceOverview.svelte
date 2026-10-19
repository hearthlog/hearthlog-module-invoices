<script lang="ts">
    import { queryDatabase } from "@hearthlog/sdk/data";
    import type { InvoiceOverview } from "../../data/invoice-list.js";
    import { Amount, Metric } from "@hearthlog/sdk/ui";
    import { formatAmount, formatNumber } from "@hearthlog/sdk/format";
    import { PhoneGlance } from "@hearthlog/sdk/ui";

    let {
        today,
        revision,
        loading = false,
        glance = true,
    }: {
        today: string;
        revision: number;
        loading?: boolean;
        /** Whether this page's top bar shows the overview's figure (Issued only). */
        glance?: boolean;
    } = $props();

    let overview = $state<InvoiceOverview | null>(null);
    let failed = $state(false);

    /** First day of the quarter that contains `today` (YYYY-MM-DD). */
    const quarterStart = $derived.by(() => {
        const [year, month] = today.split("-").map(Number);
        const first = Math.floor((month - 1) / 3) * 3 + 1;
        return `${year}-${String(first).padStart(2, "0")}-01`;
    });
    const quarterLabel = $derived(`Q${Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1}`);

    $effect(() => {
        const request = { today, periodStart: quarterStart };
        void revision;
        if (loading || !today) return;
        let cancelled = false;
        queryDatabase((repositories) => repositories.invoices.queryOverview(request))
            .then((rows) => {
                if (cancelled) return;
                overview = rows[0] ?? null;
                failed = false;
            })
            .catch(() => {
                if (!cancelled) failed = true;
            });
        return () => {
            cancelled = true;
        };
    });
</script>

{#snippet figures(sheet: boolean)}
    {#if overview}
        {@const unit = overview.currency === "CZK" ? "Kč" : overview.currency}
        <!-- Three figures in one row at every width; phones keep them in the sheet behind the top bar's figure. -->
        <section class="stor-panel grid {sheet ? 'grid-cols-1 gap-4 p-[var(--stor-panel-padding)] shadow-none' : 'grid-cols-3 px-1 py-3 max-md:hidden sm:p-[var(--stor-panel-padding)]'}" aria-label="Invoice summary">
            <div class="min-w-0 {sheet ? '' : 'px-3 sm:pl-0 sm:pr-6'}">
                <Metric label="Outstanding" detail={`${formatNumber(overview.outstandingCount)} ${overview.outstandingCount === 1 ? "invoice" : "invoices"}`}>
                    <Amount value={overview.outstanding} {unit} />
                </Metric>
            </div>
            <div class="min-w-0 {sheet ? 'border-t border-[var(--stor-border)] pt-4' : 'border-l border-[var(--stor-border)] px-3 sm:px-6'}">
                <Metric label="Overdue" tone={overview.overdueCount > 0 ? "negative" : "neutral"} detail={overview.overdueCount > 0 ? `${formatNumber(overview.overdueCount)} past due` : "Nothing late"}>
                    <Amount value={overview.overdue} {unit} />
                </Metric>
            </div>
            <div class="min-w-0 {sheet ? 'border-t border-[var(--stor-border)] pt-4' : 'border-l border-[var(--stor-border)] px-3 sm:pl-6 sm:pr-0'}">
                <Metric label={`Invoiced in ${quarterLabel}`} detail="Payable totals by issue date">
                    <Amount value={overview.invoiced} {unit} />
                </Metric>
            </div>
        </section>
    {/if}
{/snippet}

{#if overview && !failed}
    {@const unit = overview.currency === "CZK" ? "Kč" : overview.currency}
    {@const late = overview.overdueCount > 0}
    {@render figures(false)}
    {#if glance}
    <!-- Phones: what is overdue (or outstanding when nothing is) in the top bar. -->
    <PhoneGlance
        label={late ? "Overdue" : "Outstanding"}
        value={formatAmount(late ? overview.overdue : overview.outstanding)}
        {unit}
        tone={late ? "negative" : "default"}
        title="Invoices"
    >
        {@render figures(true)}
    </PhoneGlance>
    {/if}
{/if}
