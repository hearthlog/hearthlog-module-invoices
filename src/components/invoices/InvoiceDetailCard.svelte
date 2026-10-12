<script lang="ts">
    import type { Snippet } from "svelte";

    /**
     * One labelled detail card, shared by the invoice and party drawers so
     * entity details stay visually identical. Content is either a semibold
     * title with muted detail lines, or a caller-provided snippet for richer
     * layouts (amounts, addresses).
     */
    let {
        label,
        title = "",
        details = [],
        emptyText = "Not set",
        children,
    }: {
        label: string;
        title?: string;
        details?: readonly string[];
        emptyText?: string;
        children?: Snippet;
    } = $props();
</script>

<div class="min-w-0 rounded-xl bg-[var(--stor-surface-muted)] p-3">
    <p
        class="text-xs font-medium uppercase tracking-wide text-[var(--stor-muted-text)]"
    >
        {label}
    </p>
    {#if children}
        {@render children()}
    {:else if title || details.length > 0}
        {#if title}
            <p class="mt-1 text-sm font-semibold text-[var(--stor-ink)]">
                {title}
            </p>
        {/if}
        {#if details.length > 0}
            <div class="mt-1 space-y-0.5">
                {#each details as line}
                    <p class="text-xs text-[var(--stor-muted-text)]">{line}</p>
                {/each}
            </div>
        {/if}
    {:else}
        <p class="mt-1 text-sm text-[var(--stor-muted-text)]">{emptyText}</p>
    {/if}
</div>
