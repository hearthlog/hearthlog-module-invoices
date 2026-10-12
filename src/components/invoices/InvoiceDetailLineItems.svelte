<script lang="ts">
    import { formatInvoiceAmount } from "../../invoices/format.js";

    interface LineItem {
        description: string;
        quantity: number;
        unitPrice: number;
        vatRate: number;
        /** Extended net amount, computed the way each direction stores it. */
        net: number;
    }

    /**
     * Line items with subtotal and VAT breakdown, shared by both invoice
     * drawers. Each direction supplies its own `net` per line, so received
     * invoices keep their stored rounding.
     */
    let {
        items = [],
        subtotal,
        total,
        vatByRate = [],
        emptyText = "No line items recorded.",
    }: {
        items?: readonly LineItem[];
        subtotal: number;
        total: number;
        vatByRate?: readonly [number, number][];
        emptyText?: string;
    } = $props();
</script>

<section aria-label="Line items">
    <h3 class="text-sm font-semibold text-[var(--stor-ink)]">Line items</h3>
    {#if items.length > 0}
        <div
            class="mt-2 overflow-hidden rounded-xl bg-[var(--stor-surface-muted)]"
        >
            <table class="w-full text-left text-sm">
                <thead>
                    <tr class="text-xs text-[var(--stor-muted-text)]">
                        <th class="px-3 py-2 font-medium">Item</th>
                        <th
                            class="hidden px-3 py-2 text-right font-medium sm:table-cell"
                        >
                            Qty
                        </th>
                        <th
                            class="hidden px-3 py-2 text-right font-medium sm:table-cell"
                        >
                            Unit price
                        </th>
                        <th class="px-3 py-2 text-right font-medium">VAT</th>
                        <th class="px-3 py-2 text-right font-medium">
                            Amount
                        </th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-[var(--stor-border)]">
                    {#each items as item, index}
                        <tr>
                            <td class="px-3 py-2 text-[var(--stor-ink)]">
                                {item.description || `Item ${index + 1}`}
                                <span
                                    class="mt-0.5 block text-xs text-[var(--stor-muted-text)] sm:hidden"
                                >
                                    {item.quantity} × {formatInvoiceAmount(
                                        item.unitPrice,
                                    )}
                                </span>
                            </td>
                            <td
                                class="hidden px-3 py-2 text-right tabular-nums text-[var(--stor-muted-text)] sm:table-cell"
                            >
                                {item.quantity}
                            </td>
                            <td
                                class="hidden px-3 py-2 text-right tabular-nums text-[var(--stor-muted-text)] sm:table-cell"
                            >
                                {formatInvoiceAmount(item.unitPrice)}
                            </td>
                            <td
                                class="px-3 py-2 text-right tabular-nums text-[var(--stor-muted-text)]"
                            >
                                {Number(item.vatRate) || 0}%
                            </td>
                            <td
                                class="px-3 py-2 text-right font-medium tabular-nums text-[var(--stor-ink)]"
                            >
                                {formatInvoiceAmount(item.net)}
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>

        <dl class="mt-3 space-y-1 text-sm">
            <div class="flex justify-between gap-3">
                <dt class="text-[var(--stor-muted-text)]">
                    Subtotal (excl. VAT)
                </dt>
                <dd class="tabular-nums text-[var(--stor-ink)]">
                    {formatInvoiceAmount(subtotal)}
                </dd>
            </div>
            {#each vatByRate as [rate, amount] (rate)}
                <div class="flex justify-between gap-3">
                    <dt class="text-[var(--stor-muted-text)]">VAT {rate}%</dt>
                    <dd class="tabular-nums text-[var(--stor-ink)]">
                        {formatInvoiceAmount(amount)}
                    </dd>
                </div>
            {/each}
            <div
                class="flex justify-between gap-3 border-t border-[var(--stor-border)] pt-2 font-semibold text-[var(--stor-ink)]"
            >
                <dt>Total</dt>
                <dd class="tabular-nums">{formatInvoiceAmount(total)}</dd>
            </div>
        </dl>
    {:else}
        <p class="mt-2 text-sm text-[var(--stor-muted-text)]">{emptyText}</p>
    {/if}
</section>
