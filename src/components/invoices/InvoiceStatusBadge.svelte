<script lang="ts">
    import { Badge } from "@hearthlog/sdk/ui";

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
    const variant = $derived.by(() => {
        switch (state) {
            case "overdue":
                return "danger";
            case "paid":
                return "success";
            case "sent":
            case "issued":
                return "info";
            case "review":
            case "unpaid":
                return "warning";
            default:
                return "default";
        }
    });
</script>

<Badge {variant} class="stor-invoice-status whitespace-nowrap">{label}</Badge>
