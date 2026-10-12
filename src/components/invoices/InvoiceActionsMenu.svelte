<script lang="ts">
    import { DropdownMenu } from "bits-ui";
    import { CommandOnly } from "@hearthlog/sdk/ui";
    import { cn } from "@hearthlog/sdk/ui";
    import IconDotsHorizontal from "~icons/mdi/dots-horizontal";

    export interface InvoiceMenuItem {
        label: string;
        onSelect: () => void;
        tone?: "default" | "danger";
        disabled?: boolean;
        /** Hidden outside the current view, the way command actions are. */
        commandOnly?: boolean;
        /**
         * Previewing needs current data, so the item is disabled while
         * reviewing history. Decided here rather than by the caller: feature
         * routes must stay unaware of the read-model infrastructure.
         */
    }

    /**
     * One overflow menu for both invoice directions. Items are passed in as
     * closures so a row from the SQL list can drive the menu without the caller
     * having loaded the whole record. The trigger always renders; only the items
     * that write commands or preview live data are gated, so read-only actions
     * stay reachable while reviewing history.
     */
    let {
        label,
        items,
        triggerClass = "",
    }: {
        /** Describes the row for the trigger's accessible name. */
        label: string;
        items: InvoiceMenuItem[];
        triggerClass?: string;
    } = $props();

    const itemClass =
        "cursor-default px-3 py-2 text-sm text-stone-700 outline-none data-[highlighted]:bg-[var(--stor-surface-muted)] data-[disabled]:opacity-45";
    const dangerClass =
        "cursor-default px-3 py-2 text-sm text-[var(--stor-negative)] outline-none data-[highlighted]:bg-[var(--stor-negative-soft)] data-[disabled]:opacity-45";
</script>

<DropdownMenu.Root>
    <DropdownMenu.Trigger
        class={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--stor-muted-text)] transition hover:bg-[var(--stor-surface-muted)] hover:text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)]",
            triggerClass,
        )}
        aria-label={`More actions for ${label}`}
    >
        <IconDotsHorizontal class="h-4 w-4" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
        <DropdownMenu.Content
            side="bottom"
            align="end"
            sideOffset={4}
            loop
            class="stor-menu z-[var(--stor-layer-menu)] w-44 overflow-hidden py-1"
        >
            {#each items as item (item.label)}
                {#if item.commandOnly}
                    <CommandOnly>
                        {@render menuItem(item)}
                    </CommandOnly>
                {:else}
                    {@render menuItem(item)}
                {/if}
            {/each}
        </DropdownMenu.Content>
    </DropdownMenu.Portal>
</DropdownMenu.Root>

{#snippet menuItem(item: InvoiceMenuItem)}
    <DropdownMenu.Item
        class={item.tone === "danger" ? dangerClass : itemClass}
        disabled={item.disabled}
        onSelect={item.onSelect}
    >
        {item.label}
    </DropdownMenu.Item>
{/snippet}
