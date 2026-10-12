<script lang="ts">
    import IconUpload from '~icons/mdi/upload-outline';
    import IconFileUpload from '~icons/mdi/file-upload-outline';
    import { Button } from "@hearthlog/sdk/ui";
    import { readIsdocFromPdf } from '../../invoices/extraction/pdf-extract.js';
    import { readIsdocFile } from '../../invoices/extraction/isdoc.js';
    import { readInvoiceWithAi } from '../../invoices/extraction/ai.js';
    import { validateIssuedPdf } from '../../invoices/issued-file-store.js';
    import type { ExtractionResult, ExtractionWarning } from '../../invoices/extraction/types.js';

    /** A document selected for import, paired with what the reader found. */
    export interface ImportedDocumentPayload {
        result: ExtractionResult;
        xml: string | null;
        file: File;
        origin: 'embedded' | 'separate';
    }

    let {
        onFileSelected,
        onExtracted,
        disabled = false,
    }: {
        /** Fires for every accepted file, before any reader runs. */
        onFileSelected: (file: File | null) => void;
        /** Fires when a reader produces values for the form. */
        onExtracted: (payload: ImportedDocumentPayload) => void;
        disabled?: boolean;
    } = $props();

    let file = $state<File | null>(null);
    let fileError = $state('');
    let status = $state<'idle' | 'reading' | 'found' | 'none' | 'unreadable'>('idle');
    let notice = $state('');
    let warnings = $state<ExtractionWarning[]>([]);
    let run = 0;
    // AI reading runs only on an explicit click; a 503 hides it for the session.
    let aiBusy = $state(false);
    let aiDisabled = $state(false);
    let aiFound = $state(false);
    let aiNotice = $state('');
    let aiProvider = $state('');
    let aiModel = $state('');
    // A standalone ISDOC file chosen when the PDF carries none.
    let origin = $state<'embedded' | 'separate' | null>(null);
    let isdocFileBusy = $state(false);
    let isdocFileError = $state('');

    function reset(): void {
        run += 1;
        status = 'idle';
        notice = '';
        warnings = [];
        aiBusy = false;
        aiFound = false;
        aiNotice = '';
        aiProvider = '';
        aiModel = '';
        origin = null;
        isdocFileBusy = false;
        isdocFileError = '';
    }

    function apply(result: ExtractionResult, xml: string | null, source: 'embedded' | 'separate'): void {
        if (!file) return;
        origin = source;
        status = 'found';
        warnings = result.warnings;
        notice = '';
        onExtracted({ result, xml, file, origin: source });
    }

    async function handleFileChange(selected: File | null): Promise<void> {
        file = selected;
        fileError = '';
        reset();
        onFileSelected(selected);
        if (!selected) return;
        try {
            await validateIssuedPdf(selected);
        } catch (error) {
            fileError = error instanceof Error ? error.message : 'Choose a valid PDF file.';
            file = null;
            onFileSelected(null);
            return;
        }
        const current = ++run;
        status = 'reading';
        try {
            const outcome = await readIsdocFromPdf(selected);
            if (current !== run) return;
            if (outcome.kind === 'unreadable') {
                status = 'unreadable';
                notice = outcome.message;
                return;
            }
            if (outcome.kind === 'none') {
                status = 'none';
                return;
            }
            apply(outcome.result, outcome.xml, 'embedded');
        } catch {
            if (current !== run) return;
            status = 'none';
        }
    }

    /** Reads a standalone ISDOC file for a PDF that carries none. */
    async function handleIsdocFileChange(selected: File | null): Promise<void> {
        if (!selected || isdocFileBusy) return;
        isdocFileError = '';
        isdocFileBusy = true;
        try {
            const outcome = await readIsdocFile(selected);
            if (outcome.kind === 'invalid') {
                isdocFileError = outcome.message;
                return;
            }
            apply(
                {
                    ...outcome.result,
                    metadata: { ...outcome.result.metadata, origin: 'separate' },
                },
                outcome.xml,
                'separate',
            );
        } catch {
            isdocFileError = 'The ISDOC file could not be read.';
        } finally {
            isdocFileBusy = false;
        }
    }

    /** Explicit AI read for PDFs without a usable ISDOC. */
    async function readWithAi(): Promise<void> {
        if (!file || aiBusy || aiDisabled) return;
        aiBusy = true;
        aiFound = false;
        aiNotice = '';
        try {
            const outcome = await readInvoiceWithAi(file);
            if (outcome.kind === 'found') {
                apply(
                    {
                        source: 'ai',
                        invoice: outcome.invoice,
                        warnings: outcome.warnings,
                        metadata: {
                            provider: outcome.provider,
                            model: outcome.model,
                            ...(outcome.usage ? {
                                promptTokenCount: outcome.usage.promptTokenCount,
                                candidatesTokenCount: outcome.usage.candidatesTokenCount,
                                thoughtsTokenCount: outcome.usage.thoughtsTokenCount,
                                totalTokenCount: outcome.usage.totalTokenCount,
                            } : {}),
                        },
                    },
                    null,
                    origin ?? 'embedded',
                );
                aiFound = true;
                aiProvider = outcome.provider;
                aiModel = outcome.model;
            } else if (outcome.kind === 'offline') {
                aiNotice = 'Connect to the internet to read with AI.';
            } else if (outcome.kind === 'unavailable') {
                aiDisabled = true;
                aiNotice = outcome.message;
            } else {
                aiNotice = outcome.message;
            }
        } finally {
            aiBusy = false;
        }
    }
</script>

<section class="rounded-xl border border-dashed border-[var(--stor-border)] bg-[var(--stor-surface-muted)] p-4" aria-label="Import from a document">
    <label class="block cursor-pointer text-center text-sm text-[var(--stor-ink)]">
        <IconUpload class="mx-auto mb-2 h-6 w-6 text-[var(--stor-accent-strong)]" />
        <span class="font-semibold">{file?.name ?? 'Choose the invoice PDF'}</span>
        <span class="mt-1 block text-xs text-[var(--stor-muted-text)]">PDF, up to 25 MiB. The original is kept with the invoice.</span>
        <input
            type="file"
            accept="application/pdf,.pdf"
            class="mt-3 block w-full text-xs"
            {disabled}
            onchange={(event) => {
                const input = event.currentTarget;
                const picked = input.files?.[0] ?? null;
                input.value = '';
                void handleFileChange(picked);
            }}
        />
    </label>

    {#if fileError}
        <p role="alert" class="mt-3 text-xs text-[var(--stor-accent-strong)]">{fileError}</p>
    {/if}

    {#if status === 'reading'}
        <div class="mt-3 rounded-xl border border-[var(--stor-border)] bg-[var(--stor-surface)] p-3 text-sm" role="status">
            <p class="font-semibold text-[var(--stor-ink)]">Looking for an attached ISDOC…</p>
            <p class="mt-1 text-xs text-[var(--stor-muted-text)]">The file is read on this device; nothing is uploaded for reading.</p>
        </div>
    {:else if status === 'found'}
        <div class="mt-3 rounded-xl border border-[var(--stor-positive)] bg-[var(--stor-positive-soft)] p-3 text-sm" role="status">
            <p class="font-semibold text-[var(--stor-positive)]">{origin === 'separate' ? 'Filled from the ISDOC file' : 'Filled from attached ISDOC'}</p>
            <p class="mt-1 text-xs text-[var(--stor-muted-text)]">Review the values below, then import the invoice.</p>
            {#if notice}<p class="mt-1 text-xs text-[var(--stor-muted-text)]">{notice}</p>{/if}
            {#if warnings.length}
                <ul class="mt-2 list-disc space-y-0.5 pl-4 text-xs text-[var(--stor-accent-strong)]">
                    {#each warnings as warning}
                        <li>{warning.message}</li>
                    {/each}
                </ul>
            {/if}
        </div>
    {/if}

    {#if file && status !== 'reading' && status !== 'found'}
        <div class="mt-3 rounded-xl border border-[var(--stor-border)] bg-[var(--stor-surface)] p-3 text-sm" role="status">
            <p class="font-semibold text-[var(--stor-ink)]">{status === 'unreadable' ? 'The PDF could not be read' : 'No attached ISDOC found'}</p>
            <p class="mt-1 text-xs text-[var(--stor-muted-text)]">
                {status === 'unreadable' ? `${notice} ` : ''}Choose how to fill the invoice; the fields stay editable.
            </p>
            <div class="mt-2 flex flex-wrap items-center gap-2">
                <label class="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--stor-border)] bg-[var(--stor-surface)] px-3 text-xs font-semibold text-[var(--stor-ink)] transition hover:bg-[var(--stor-surface-muted)] {isdocFileBusy || disabled ? 'pointer-events-none opacity-60' : ''}">
                    <IconFileUpload class="h-4 w-4" />
                    {isdocFileBusy ? 'Reading…' : 'Upload ISDOC file'}
                    <input
                        type="file"
                        class="sr-only"
                        accept=".isdoc,.xml,application/xml,text/xml"
                        onchange={(event) => {
                            const input = event.currentTarget;
                            const picked = input.files?.[0] ?? null;
                            input.value = '';
                            void handleIsdocFileChange(picked);
                        }}
                    />
                </label>
                {#if !aiDisabled}
                    <Button size="sm" variant="secondary" onclick={() => void readWithAi()} disabled={aiBusy || disabled}>
                        {aiBusy ? 'Reading…' : aiFound ? 'Read again' : 'Read with AI'}
                    </Button>
                {/if}
                <span class="text-xs text-[var(--stor-muted-text)]">or enter the details manually</span>
            </div>
            {#if isdocFileError}<p role="alert" class="mt-2 text-xs text-[var(--stor-accent-strong)]">{isdocFileError}</p>{/if}
            {#if aiFound && aiProvider}
                <p class="mt-2 text-xs text-[var(--stor-positive)]">Filled by AI ({aiProvider}{aiModel ? ` ${aiModel}` : ''}) — check the values.</p>
            {:else if aiNotice}
                <p class="mt-2 text-xs text-[var(--stor-accent-strong)]">{aiNotice}</p>
            {:else if aiDisabled}
                <p class="mt-2 text-xs text-[var(--stor-muted-text)]">AI reading is not configured for this site.</p>
            {/if}
        </div>
    {/if}
</section>
