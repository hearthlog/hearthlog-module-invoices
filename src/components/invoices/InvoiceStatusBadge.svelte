<script lang="ts">

    /**
     * Purely presentational: `status` arrives already resolved, including
     * `overdue`, so the badge never re-derives it from a date. The list gets it
     * from the SQL projection and the detail panel from `isInvoiceOverdue`.
     */
    let {
        status,
        documentState,
    }: {
        status: string;
        documentState?: "draft" | "issued" | null;
    } = $props();

    /** Stored statuses are lowercase identifiers; the badge owns their wording. */
    const STATUS_LABELS: Record<string, string> = {
        draft: "Draft",
        issued: "Issued",
        sent: "Sent",
        paid: "Paid",
        unpaid: "Unpaid",
        overdue: "Overdue",
        review: "To review",
    };

    /** A draft whose document was already issued reads as issued. */
    const state = $derived(status === "draft" && documentState === "issued" ? "issued" : status);
    const label = $derived(STATUS_LABELS[state] ?? status);
    const palette = $derived.by(() => {
        switch (state) {
            case "overdue":
                return { text: "var(--stor-negative)", background: "var(--stor-negative-soft)", border: "color-mix(in srgb, var(--stor-negative), transparent 65%)" };
            case "paid":
                return { text: "var(--stor-positive)", background: "var(--stor-positive-soft)", border: "color-mix(in srgb, var(--stor-positive), transparent 65%)" };
            case "sent":
            case "issued":
                return { text: "var(--stor-info)", background: "var(--stor-info-soft)", border: "var(--stor-info-border)" };
            case "review":
                return { text: "var(--stor-warning)", background: "var(--stor-warning-soft)", border: "color-mix(in srgb, var(--stor-warning), transparent 65%)" };
            default:
                return { text: "var(--stor-muted-text)", background: "var(--stor-surface-muted)", border: "var(--stor-border)" };
        }
    });
</script>

<span
    class="stor-invoice-status inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium"
    style:color={palette.text}
    style:background={palette.background}
    style:border-color={palette.border}
>
    <span aria-hidden="true" class="h-1.5 w-1.5 shrink-0 rounded-full" style:background="currentColor"></span>
    {label}
</span>
