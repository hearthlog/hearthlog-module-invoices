<script lang="ts">
    import { formatFileSize } from "../../invoices/format.js";
    import { invoiceStorageLabel } from "../../invoices/invoice-file-store.js";
    import { formatIsdocGaps } from "../../invoices/isdoc-status.js";
    import IsdocActions from "./IsdocActions.svelte";

    /** ISDOC bytes loaded with the embedded attachment's own file name. */
    interface IsdocDocument {
        blob: Blob;
        fileName?: string;
    }

    /**
     * The Electronic invoice (ISDOC) card, identical in both invoice drawers.
     *
     * `load` marks the ISDOC as available: a stored original or an export from
     * the invoice PDF. When the ISDOC profile is incomplete, `missing` lists
     * the required facts and the actions stay visible but disabled.
     */
    let {
        fileName = "invoice.isdoc",
        load = null,
        sizeBytes = 0,
        storageStatus = "",
        note = "",
        missing = [],
        message = "",
    }: {
        fileName?: string;
        load?: (() => Promise<Blob | IsdocDocument>) | null;
        sizeBytes?: number;
        storageStatus?: string;
        /** Extra line shown below an available ISDOC. */
        note?: string;
        /** Missing ISDOC profile facts; disables the actions. */
        missing?: readonly string[];
        /** Explanation shown when no ISDOC can be offered. */
        message?: string;
    } = $props();

    const available = $derived(Boolean(load) && missing.length === 0);
    const explanation = $derived.by(() => {
        if (missing.length > 0) {
            return `Complete the missing details: ${formatIsdocGaps(missing)}.`;
        }
        return message;
    });
    const unavailable = () =>
        Promise.reject(new Error("The electronic invoice is unavailable."));
</script>

<div class="min-w-0 rounded-xl bg-[var(--stor-surface-muted)] p-3">
    <p
        class="text-xs font-medium uppercase tracking-wide text-[var(--stor-muted-text)]"
    >
        Electronic invoice (ISDOC)
    </p>
    <div
        class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 text-sm text-[var(--stor-ink)]"
    >
        {#if available}
            <span class="min-w-0 truncate font-semibold">{fileName}</span>
            {#if sizeBytes || storageStatus}
                <span class="text-xs text-[var(--stor-muted-text)]">
                    {formatFileSize(sizeBytes)} · {invoiceStorageLabel(
                        storageStatus,
                    )}
                </span>
            {/if}
        {:else}
            <p class="min-w-0 flex-1 text-sm text-[var(--stor-muted-text)]">
                {explanation}
            </p>
        {/if}
        <IsdocActions
            {fileName}
            load={load ?? unavailable}
            disabled={!available}
        />
    </div>
    {#if available && note}
        <p class="mt-1 text-xs text-[var(--stor-muted-text)]">{note}</p>
    {/if}
</div>
