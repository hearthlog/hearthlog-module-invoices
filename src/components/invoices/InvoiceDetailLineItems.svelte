<script lang="ts">
    import { formatInvoiceAmount } from "../../invoices/format.js";

    interface LineItem {
        description: string;
        quantity: number;
        /** Optional unit label (e.g. HOD) shown after the quantity. */
        unit?: string;
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
    <h3 class="flex items-baseline justify-between text-[17px] font-medium tracking-tight text-[var(--stor-ink)]">Line items<small class="text-xs font-normal text-[var(--stor-faint-text)]">{items.length} item{items.length === 1 ? '' : 's'}</small></h3>
    {#if items.length > 0}
        <div
            class="mt-2 overflow-hidden"
        >
            <table class="w-full text-left text-sm">
                <thead>
                    <tr class="stor-overline border-b border-[var(--stor-border)]">
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
                                    {item.quantity}{item.unit ? ` ${item.unit}` : ""} × {formatInvoiceAmount(
                                        item.unitPrice,
                                    )}
                                </span>
                            </td>
                            <td
                                class="hidden px-3 py-2 text-right tabular-nums text-[var(--stor-muted-text)] sm:table-cell"
                            >
                                {item.quantity}{item.unit ? ` ${item.unit}` : ""}
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

        <dl class="ml-auto mt-3 w-full max-w-[18rem] space-y-1 text-sm">
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
                class="mt-1 flex justify-between gap-3 border-t border-[var(--stor-border)] pt-2.5 text-[15px] font-semibold text-[var(--stor-ink)]"
            >
                <dt>Payable</dt>
                <dd class="tabular-nums">{formatInvoiceAmount(total)}</dd>
            </div>
        </dl>
    {:else}
        <p class="mt-2 text-sm text-[var(--stor-muted-text)]">{emptyText}</p>
    {/if}
</section>
