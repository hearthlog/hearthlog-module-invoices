<script lang="ts">
    import { formatInvoiceAmount, formatInvoiceDate } from "../../invoices/format.js";
    import InvoiceDetailCard from "./InvoiceDetailCard.svelte";

    /** Total/VAT and due/issue dates, identical in both invoice drawers. */
    let {
        total,
        vatTotal,
        issueDate,
        dueDate,
        taxPointDate = "",
    }: {
        total: number;
        vatTotal: number;
        issueDate: string | null;
        dueDate: string | null;
        taxPointDate?: string | null;
    } = $props();
</script>

<section class="grid grid-cols-2 gap-3" aria-label="Invoice summary">
    <InvoiceDetailCard label="Total">
        <p
            class="mt-1 text-xl font-semibold tabular-nums text-[var(--stor-ink)]"
        >
            {formatInvoiceAmount(total)}
        </p>
        <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
            incl. {formatInvoiceAmount(vatTotal)} VAT
        </p>
    </InvoiceDetailCard>
    <InvoiceDetailCard label="Due date">
        <p class="mt-1 text-sm font-semibold text-[var(--stor-ink)]">
            {formatInvoiceDate(dueDate)}
        </p>
        <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
            Issued {formatInvoiceDate(issueDate)}
        </p>
        {#if taxPointDate}
            <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                Tax point {formatInvoiceDate(taxPointDate)}
            </p>
        {/if}
    </InvoiceDetailCard>
</section>
