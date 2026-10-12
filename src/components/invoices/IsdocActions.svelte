<script lang="ts">
    import IconDownload from '~icons/mdi/download-outline';
    import IconOpenInNew from '~icons/mdi/open-in-new';
    import { notify } from '@hearthlog/sdk/runtime';

    /** Loaded ISDOC bytes, optionally with the embedded file's own name. */
    interface IsdocDocument {
        blob: Blob;
        fileName?: string;
    }

    /** View/download actions for a stored or exported ISDOC XML. */
    let {
        fileName,
        load,
        disabled = false,
    }: {
        fileName: string;
        load: () => Promise<Blob | IsdocDocument>;
        disabled?: boolean;
    } = $props();

    let busy = $state(false);

    async function withBlob(action: (url: string, name: string) => void): Promise<void> {
        if (busy) return;
        busy = true;
        try {
            const loaded = await load();
            const blob = loaded instanceof Blob ? loaded : loaded.blob;
            const name =
                loaded instanceof Blob
                    ? fileName
                    : loaded.fileName || fileName;
            const url = URL.createObjectURL(blob);
            try {
                action(url, name);
            } finally {
                window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
            }
        } catch (error) {
            notify.error(error instanceof Error ? error.message : 'The electronic invoice could not be loaded.');
        } finally {
            busy = false;
        }
    }

    function view(): void {
        void withBlob((url) => window.open(url, '_blank', 'noopener'));
    }

    function download(): void {
        void withBlob((url, name) => {
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = name || 'invoice.isdoc';
            anchor.click();
        });
    }
</script>

<div class="ml-auto flex shrink-0 items-center gap-1.5">
    <button
        type="button"
        class="inline-flex min-h-8 items-center gap-1 rounded-lg border border-[var(--stor-border)] px-2.5 text-xs font-semibold text-[var(--stor-ink)] transition hover:bg-[var(--stor-surface)] disabled:opacity-50"
        disabled={busy || disabled}
        onclick={view}
    >
        <IconOpenInNew class="h-4 w-4" /> View
    </button>
    <button
        type="button"
        class="inline-flex min-h-8 items-center gap-1 rounded-lg border border-[var(--stor-border)] px-2.5 text-xs font-semibold text-[var(--stor-ink)] transition hover:bg-[var(--stor-surface)] disabled:opacity-50"
        disabled={busy || disabled}
        onclick={download}
    >
        <IconDownload class="h-4 w-4" /> Download
    </button>
</div>
