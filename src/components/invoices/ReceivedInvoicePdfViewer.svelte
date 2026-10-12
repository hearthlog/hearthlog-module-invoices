<script lang="ts">
    import { onDestroy } from "svelte";
    import IconAlert from "~icons/mdi/alert-circle-outline";
    import IconDownload from "~icons/mdi/download-outline";
    import IconLoading from "~icons/mdi/loading";
    import IconOpenInNew from "~icons/mdi/open-in-new";
    import { Button } from "@hearthlog/sdk/ui";
    import type { ReceivedInvoice } from "../../data/invoices.js";
    import { getReceivedPdf } from "../../invoices/received-file-store.js";

    let {
        invoice = null,
        active = true,
    }: {
        invoice?: ReceivedInvoice | null;
        active?: boolean;
    } = $props();

    let url = $state<string | null>(null);
    let loading = $state(false);
    let error = $state("");
    let loadedInvoiceId: string | null = null;
    let loadedFileId: string | null = null;
    let run = 0;

    /**
     * Load the original file the first time the viewer becomes active and
     * whenever a different received invoice (or replacement file) is shown.
     */
    $effect(() => {
        if (!active || !invoice) return;
        if (
            loadedInvoiceId === invoice.id &&
            loadedFileId === invoice.file_id &&
            url !== null
        ) {
            return;
        }
        loadedInvoiceId = invoice.id;
        loadedFileId = invoice.file_id;
        void load(invoice);
    });

    async function load(target: ReceivedInvoice): Promise<void> {
        const current = ++run;
        loading = true;
        error = "";
        try {
            const blob = await getReceivedPdf(target);
            if (current !== run) return;
            replaceUrl(URL.createObjectURL(blob));
        } catch (cause) {
            if (current !== run) return;
            error =
                cause instanceof Error
                    ? cause.message
                    : "The PDF could not be loaded.";
        } finally {
            if (current === run) loading = false;
        }
    }

    function retry(): void {
        if (invoice) void load(invoice);
    }

    function replaceUrl(next: string | null): void {
        const previous = url;
        url = next;
        if (previous && previous !== next) URL.revokeObjectURL(previous);
    }

    onDestroy(() => replaceUrl(null));

    const fileName = $derived(invoice?.file_name || "invoice.pdf");
</script>

<div class="flex min-h-0 flex-1 flex-col">
    <div
        class="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--stor-border)] px-3 py-2 sm:px-4"
    >
        <p class="min-w-0 flex-1 truncate text-xs text-[var(--stor-muted-text)]">
            {fileName}
        </p>
        {#if url}
            <div class="flex shrink-0 items-center gap-1.5">
                <a
                    class="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--stor-border)] px-3 text-xs font-semibold text-[var(--stor-ink)] transition hover:bg-[var(--stor-surface-muted)]"
                    href={url}
                    download={fileName}
                >
                    <IconDownload class="h-4 w-4" />
                    Download
                </a>
                <a
                    class="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--stor-border)] px-3 text-xs font-semibold text-[var(--stor-ink)] transition hover:bg-[var(--stor-surface-muted)]"
                    href={url}
                    target="_blank"
                    rel="noopener"
                >
                    <IconOpenInNew class="h-4 w-4" />
                    Open
                </a>
            </div>
        {/if}
    </div>

    <div
        class="relative min-h-0 flex-1 overflow-y-auto bg-stone-200/70 dark:bg-stone-900/50"
    >
        {#if loading || (!url && !error)}
            <div
                class="flex h-full min-h-[16rem] flex-col items-center justify-center gap-3 p-6"
                role="status"
                aria-live="polite"
            >
                <IconLoading
                    class="h-8 w-8 animate-spin text-[var(--stor-muted-text)]"
                />
                <p class="text-sm font-medium text-[var(--stor-ink)]">
                    Loading invoice…
                </p>
            </div>
        {:else if error}
            <div
                class="flex h-full min-h-[16rem] flex-col items-center justify-center gap-4 p-6 text-center"
                role="alert"
            >
                <IconAlert class="h-8 w-8 text-[var(--stor-negative)]" />
                <p class="max-w-md text-sm text-[var(--stor-ink)]">{error}</p>
                <Button size="sm" onclick={retry}>Retry</Button>
            </div>
        {:else if url}
            <iframe
                class="h-full min-h-[16rem] w-full border-0 bg-white"
                title="Received invoice PDF"
                src={url}
            ></iframe>
        {/if}
    </div>
</div>
