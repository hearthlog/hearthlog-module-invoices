<script lang="ts">
    import { onDestroy } from "svelte";
    import IconAlert from "~icons/mdi/alert-circle-outline";
    import IconDownload from "~icons/mdi/download-outline";
    import IconLoading from "~icons/mdi/loading";
    import IconOpenInNew from "~icons/mdi/open-in-new";
    import IconRefresh from "~icons/mdi/refresh";
    import { Button } from "@hearthlog/sdk/ui";
    import {
        buildInvoiceGenerationRequest,
        isdocDocumentGaps,
        type BuildInvoiceRequestOptions,
        type InvoicePartySource,
    } from "../../api/invoice-renderer.js";
    import { formatIsdocGaps } from "../../invoices/isdoc-status.js";
    import { canonicalInvoicePdfRequestKey } from "../../api/invoice-pdf-fingerprint.js";
    import {
        resolveInvoicePdf,
        revokeInvoicePdfUrl,
        triggerInvoicePdfDownload,
        InvoicePdfStaleError,
    } from "../../api/invoice-pdf-cache.js";
    import { getIssuedPdf } from "../../invoices/issued-file-store.js";
    import type { Invoice } from "../../data/invoices.js";

    /** The bytes currently on screen, with what produced them. */
    interface LoadedPreview {
        blob: Blob;
        filename: string;
        /** Generation key for rendered documents; null for imported originals. */
        requestKey: string | null;
        isdocAttached: boolean | null;
        original: boolean;
    }

    type PreviewState =
        | { status: "idle" }
        | {
              status: "loading";
              requestKey: string | null;
              regenerating: boolean;
          }
        | { status: "ready"; document: LoadedPreview }
        | { status: "error"; message: string; requestKey: string | null }
        | { status: "stale" };

    let {
        invoice = null,
        parties = [],
        isOverdue = false,
        active = true,
    }: {
        invoice?: Invoice | null;
        /** The unified party directory; the invoice slot decides the role. */
        parties?: InvoicePartySource[];
        isOverdue?: boolean;
        /** When false the viewer keeps its state but does not start loading. */
        active?: boolean;
    } = $props();

    let preview = $state<PreviewState>({ status: "idle" });
    let viewerUrl = $state<string | null>(null);
    let viewerReady = $state(false);
    let viewerSupported = $state(true);
    let loadedRequestKey = $state<string | null>(null);
    let loadedInvoiceId: string | null = null;
    /** The original file id the viewer last loaded, so a replacement reloads. */
    let loadedFileId: string | null = null;
    let loadedIsOriginal = $state(false);
    let runId = 0;

    function buildOptions(): BuildInvoiceRequestOptions {
        return { suppliers: parties, customers: parties, isOverdue };
    }

    /** An imported invoice keeps its source document; renderer output is secondary. */
    const hasOriginal = $derived(Boolean(invoice?.file_id));

    /** Missing ISDOC facts in the current invoice, for the status message. */
    const isdocGaps = $derived.by((): string[] => {
        if (!invoice) return [];
        try {
            return isdocDocumentGaps(
                buildInvoiceGenerationRequest(invoice, buildOptions()).invoice,
            );
        } catch {
            return [];
        }
    });

    const isdocMessage = $derived.by((): string => {
        if (preview.status !== "ready") return "";
        if (preview.document.isdocAttached === true) {
            return "Includes the electronic invoice (ISDOC).";
        }
        if (preview.document.isdocAttached !== false) {
            return "Electronic invoice (ISDOC) attachment status unavailable.";
        }
        if (isdocGaps.length > 0) {
            return `This PDF does not include the electronic invoice (ISDOC). Complete the missing details: ${formatIsdocGaps(isdocGaps)}.`;
        }
        return "This PDF does not include the electronic invoice (ISDOC).";
    });

    /** Header note: what is shown and where the imported copy lives. */
    const previewMessage = $derived.by((): string => {
        if (preview.status !== "ready") return "";
        if (!preview.document.original) {
            return hasOriginal
                ? "Rendered from the invoice data; the imported original is still stored."
                : isdocMessage;
        }
        const isdoc = preview.document.isdocAttached === true ? " · includes the stored ISDOC" : "";
        return `Imported original${isdoc}${storageNote()}`;
    });

    function storageNote(): string {
        switch (invoice?.storage_status) {
            case "uploaded":
                return " · stored on the server";
            case "queued":
                return " · saved on this device, upload pending";
            case "failed":
                return " · upload failed, saved on this device only";
            case "missing":
                return " · server copy missing, upload it again from this device";
            default:
                return "";
        }
    }

    /** Canonical key of the data currently shown by the page. */
    const currentRequestKey = $derived.by((): string | null => {
        if (!invoice) return null;
        try {
            return canonicalInvoicePdfRequestKey(
                buildInvoiceGenerationRequest(invoice, buildOptions()),
            );
        } catch {
            return null;
        }
    });

    const loadedKey = $derived(
        preview.status === "ready"
            ? preview.document.requestKey
            : preview.status === "loading"
              ? preview.requestKey
              : null,
    );

    /** The invoice changed while its preview was loading or displayed. */
    const stale = $derived(
        active &&
            invoice !== null &&
            !loadedIsOriginal &&
            loadedKey !== null &&
            loadedKey !== currentRequestKey,
    );

    const canUseDocument = $derived(
        preview.status === "ready" && !stale,
    );

    const canRegenerate = $derived(
        invoice !== null && preview.status !== "loading",
    );

    /** Show the imported original again after a regeneration. */
    const canShowOriginal = $derived(
        hasOriginal &&
            preview.status === "ready" &&
            !preview.document.original,
    );

    /**
     * Start loading the first time the viewer becomes active and whenever a
     * different invoice (or replacement file) is selected. Switching tabs
     * keeps the resolved copy.
     */
    $effect(() => {
        if (!active || !invoice) return;
        const fileId = invoice.file_id || null;
        if (loadedInvoiceId === invoice.id && loadedFileId === fileId) return;
        loadedInvoiceId = invoice.id;
        loadedFileId = fileId;
        startLoad(false);
    });

    onDestroy(() => releaseViewerUrl());

    function beginLoad(): void {
        startLoad(false);
    }

    /** Bypass the saved copies and render the invoice again. */
    function regenerate(): void {
        startLoad(true);
    }

    function showOriginal(): void {
        const target = invoice;
        if (!target) return;
        startLoad(false, true);
    }

    function startLoad(forceRegenerate: boolean, forceOriginal = false): void {
        const target = invoice;
        if (!target) return;
        loadedIsOriginal = !forceRegenerate && (forceOriginal || Boolean(target.file_id));
        if (loadedIsOriginal) void loadOriginal(target);
        else void loadRendered(target, forceRegenerate);
    }

    /** The source document of an imported invoice. */
    async function loadOriginal(target: Invoice): Promise<void> {
        const current = ++runId;
        loadedRequestKey = null;
        preview = { status: "loading", requestKey: null, regenerating: false };
        try {
            const blob = await getIssuedPdf(target);
            if (current !== runId) return;
            viewerSupported = supportsInlinePdf();
            viewerReady = !viewerSupported;
            replaceViewerUrl(URL.createObjectURL(blob));
            preview = {
                status: "ready",
                document: {
                    blob,
                    filename: target.file_name || `invoice-${target.invoice_number}.pdf`,
                    requestKey: null,
                    isdocAttached: target.isdoc_file_id ? true : null,
                    original: true,
                },
            };
        } catch (error: unknown) {
            if (current !== runId) return;
            preview = {
                status: "error",
                message:
                    error instanceof Error && error.message
                        ? error.message
                        : "The original document could not be loaded. Try again.",
                requestKey: null,
            };
        }
    }

    /** The app's own PDF generated from the invoice data. */
    async function loadRendered(target: Invoice, forceRegenerate: boolean): Promise<void> {
        const current = ++runId;
        // Capture the key synchronously so a page edit cannot be mistaken for
        // the loaded snapshot while the request is in flight.
        loadedRequestKey = currentRequestKey;
        preview = {
            status: "loading",
            requestKey: loadedRequestKey,
            regenerating: forceRegenerate,
        };
        try {
            const document = await resolveInvoicePdf(target, buildOptions(), { forceRegenerate });
            if (current !== runId) return;
            viewerSupported = supportsInlinePdf();
            viewerReady = !viewerSupported;
            replaceViewerUrl(URL.createObjectURL(document.blob));
            preview = {
                status: "ready",
                document: {
                    blob: document.blob,
                    filename: document.filename,
                    requestKey: document.requestKey,
                    isdocAttached: document.isdocAttached,
                    original: false,
                },
            };
        } catch (error: unknown) {
            if (current !== runId) return;
            if (error instanceof InvoicePdfStaleError) {
                preview = { status: "stale" };
                return;
            }
            preview = {
                status: "error",
                message:
                    error instanceof Error && error.message
                        ? error.message
                        : "The invoice PDF could not be loaded. Try again.",
                requestKey: loadedRequestKey,
            };
        }
    }

    function replaceViewerUrl(url: string | null): void {
        const previous = viewerUrl;
        viewerUrl = url;
        if (previous && previous !== url) revokeInvoicePdfUrl(previous);
    }

    function releaseViewerUrl(): void {
        if (!viewerUrl) return;
        revokeInvoicePdfUrl(viewerUrl);
        viewerUrl = null;
    }

    function download(): void {
        if (!canUseDocument || preview.status !== "ready") return;
        triggerInvoicePdfDownload(preview.document);
    }

    function openInNewTab(): void {
        if (!viewerUrl || !canUseDocument) return;
        window.open(viewerUrl, "_blank", "noopener,noreferrer");
    }

    function supportsInlinePdf(): boolean {
        const candidate = navigator as Navigator & {
            pdfViewerEnabled?: boolean;
        };
        return candidate.pdfViewerEnabled !== false;
    }
</script>

<div class="flex min-h-0 flex-1 flex-col">
    <div
        class="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--stor-border)] px-3 py-2 sm:px-4"
    >
        <div class="min-w-0 flex-1">
            {#if preview.status === "ready"}
                <p class="text-xs text-[var(--stor-muted-text)]">
                    {previewMessage}
                </p>
            {:else}
                <p class="text-xs text-[var(--stor-muted-text)]">
                    PDF preview
                </p>
            {/if}
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
            <Button
                variant="secondary"
                size="sm"
                disabled={!canUseDocument}
                onclick={download}
            >
                <IconDownload class="h-4 w-4" />
                Download
            </Button>
            <Button
                variant="secondary"
                size="sm"
                aria-label="Open invoice PDF in a new tab"
                disabled={!canUseDocument}
                onclick={openInNewTab}
            >
                <IconOpenInNew class="h-4 w-4" />
                <span class="hidden sm:inline">Open in new tab</span>
            </Button>
            {#if canShowOriginal}
                <Button
                    variant="secondary"
                    size="sm"
                    aria-label="Show the imported original document"
                    title="Show the original document that was imported"
                    disabled={!canRegenerate}
                    onclick={showOriginal}
                >
                    <span class="hidden sm:inline">Show original</span>
                    <span class="sm:hidden">Original</span>
                </Button>
            {/if}
            <Button
                variant="secondary"
                size="sm"
                aria-label="Force regenerate invoice PDF"
                title="Render a fresh PDF from the invoice data, ignoring the saved copy"
                disabled={!canRegenerate}
                onclick={regenerate}
            >
                <IconRefresh class="h-4 w-4" />
                <span class="hidden sm:inline">Regenerate</span>
            </Button>
        </div>
    </div>

    <div
        class="relative min-h-0 flex-1 overflow-y-auto bg-stone-200/70 dark:bg-stone-900/50"
    >
        {#if stale}
            <div
                class="flex h-full min-h-[16rem] flex-col items-center justify-center gap-4 p-6 text-center"
                role="status"
                aria-live="polite"
            >
                <p class="max-w-md text-sm text-[var(--stor-ink)]">
                    This invoice changed, so the preview is no longer current.
                    Reload it to see the updated document.
                </p>
                <div class="flex flex-wrap justify-center gap-2">
                    <Button size="sm" onclick={beginLoad}>Reload preview</Button>
                </div>
            </div>
        {:else if preview.status === "loading" || preview.status === "idle"}
            <div
                class="flex h-full min-h-[16rem] flex-col items-center justify-center gap-3 p-6"
                role="status"
                aria-live="polite"
            >
                <IconLoading
                    class="h-8 w-8 animate-spin text-[var(--stor-muted-text)]"
                />
                <p class="text-sm font-medium text-[var(--stor-ink)]">
                    {preview.status === "loading" && preview.regenerating
                        ? "Regenerating invoice…"
                        : "Loading invoice…"}
                </p>
            </div>
        {:else if preview.status === "error"}
            <div
                class="flex h-full min-h-[16rem] flex-col items-center justify-center gap-4 p-6 text-center"
                role="alert"
            >
                <IconAlert class="h-8 w-8 text-[var(--stor-negative)]" />
                <p class="max-w-md text-sm text-[var(--stor-ink)]">
                    {preview.message}
                </p>
                <div class="flex flex-wrap justify-center gap-2">
                    <Button size="sm" onclick={beginLoad}>Retry</Button>
                </div>
            </div>
        {:else if preview.status === "ready"}
            {#if viewerSupported}
                <iframe
                    class="h-full min-h-[16rem] w-full border-0 bg-white"
                    title={`PDF preview of invoice ${invoice?.invoice_number ?? ""}`}
                    src={viewerUrl ?? "about:blank"}
                    onload={() => (viewerReady = true)}
                ></iframe>
                {#if !viewerReady}
                    <div
                        class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--stor-surface)]"
                        role="status"
                        aria-live="polite"
                    >
                        <IconLoading
                            class="h-8 w-8 animate-spin text-[var(--stor-muted-text)]"
                        />
                        <p
                            class="text-sm font-medium text-[var(--stor-ink)]"
                        >
                            Loading invoice…
                        </p>
                    </div>
                {/if}
            {:else}
                <div
                    class="flex h-full min-h-[16rem] flex-col items-center justify-center gap-4 p-6 text-center"
                    role="status"
                >
                    <p class="max-w-md text-sm text-[var(--stor-ink)]">
                        This browser cannot display PDFs inline. Open the
                        document in a new tab or download it.
                    </p>
                </div>
            {/if}
        {/if}
    </div>
</div>
