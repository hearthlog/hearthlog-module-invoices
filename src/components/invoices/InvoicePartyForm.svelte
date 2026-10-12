<script lang="ts">
    import { untrack } from "svelte";
    import { Button } from "@hearthlog/sdk/ui";
    import { Drawer } from "@hearthlog/sdk/ui";
    import InvoicePartyFields from "./InvoicePartyFields.svelte";
    import {
        invoicePartyForm,
        invoicePartyFromForm,
        type InvoicePartySource,
    } from "../../invoices/document.js";
    import IconClose from "~icons/mdi/close";

    /** The values one company record save carries. */
    export type InvoicePartyDraft = InvoicePartySource;

    let {
        role,
        initial,
        title = "New party",
        description = "",
        submitLabel,
        variant = "card",
        show = true,
        onSave,
        onSaved,
        onCancel,
    }: {
        /** Prefill hint for the registration footer; never stored. */
        role?: "supplier" | "customer";
        /** Existing record to edit; absent means create. */
        initial?: InvoicePartySource;
        title?: string;
        /** Drawer description; ignored by the inline card. */
        description?: string;
        submitLabel?: string;
        /** "card" sits inline in another form; "drawer" opens the right-side panel. */
        variant?: "card" | "drawer";
        /** Drawer visibility; the inline card is always visible. */
        show?: boolean;
        /** Returns the saved record, or null when the user backed out. */
        onSave: (
            draft: InvoicePartyDraft,
        ) => Promise<{ id: string; name: string } | null>;
        onSaved: (party: { id: string; name: string }) => void;
        onCancel: () => void;
    } = $props();

    const uid = $props.id();
    const formId = `${uid}-party-form`;
    // The drawer variant resets from `initial` each time it opens; the inline
    // card keeps the values it was created with.
    let form = $state(untrack(() => invoicePartyForm(initial, role)));
    let saving = $state(false);
    let errorMessage = $state("");

    // The drawer stays mounted so it can animate out; opening it starts a
    // fresh session for the record it was opened with.
    $effect.pre(() => {
        if (variant !== "drawer" || !show) return;
        form = invoicePartyForm(initial, role);
        errorMessage = "";
    });

    const editing = $derived(Boolean(initial));
    const actionLabel = $derived(
        saving ? "Saving…" : (submitLabel ?? (editing ? "Save party" : "Add party")),
    );
    const valid = $derived(
        Boolean(
            form.name.trim() &&
                form.street.trim() &&
                form.city.trim() &&
                form.ico.trim(),
        ),
    );

    async function submit(event: SubmitEvent) {
        event.preventDefault();
        if (saving) return;
        if (!valid) {
            errorMessage = "Fill in name, street, city, and company ID.";
            return;
        }

        saving = true;
        errorMessage = "";
        try {
            const party = await onSave(invoicePartyFromForm(form));
            if (!party) return;
            onSaved(party);
        } catch (error) {
            errorMessage =
                error instanceof Error
                    ? error.message
                    : "The party could not be saved.";
        } finally {
            saving = false;
        }
    }
</script>

{#if variant === "drawer"}
    <Drawer {show} {title} {description} onClose={onCancel}>
        <form id={formId} class="space-y-4" onsubmit={submit} aria-label={title}>
            <InvoicePartyFields bind:value={form} />

            {#if errorMessage}
                <p class="text-sm text-[var(--stor-negative)]" role="alert">
                    {errorMessage}
                </p>
            {/if}
        </form>
        {#snippet footer()}
            <Button
                type="button"
                variant="secondary"
                size="sm"
                onclick={onCancel}
                disabled={saving}
            >
                Cancel
            </Button>
            <Button type="submit" form={formId} size="sm" disabled={saving}>
                {actionLabel}
            </Button>
        {/snippet}
    </Drawer>
{:else}
    <form
        class="space-y-3 rounded-xl bg-[var(--stor-surface-muted)] p-3"
        onsubmit={submit}
        aria-label={title}
    >
        <div class="flex items-center justify-between gap-3">
            <h3 class="text-sm font-semibold text-[var(--stor-ink)]">{title}</h3>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Close ${title.toLowerCase()} form`}
                onclick={onCancel}
                disabled={saving}
            >
                <IconClose class="h-4 w-4" />
            </Button>
        </div>

        <InvoicePartyFields bind:value={form} />

        {#if errorMessage}
            <p class="text-sm text-[var(--stor-negative)]" role="alert">
                {errorMessage}
            </p>
        {/if}

        <div class="flex justify-end gap-2">
            <Button
                type="button"
                variant="secondary"
                size="sm"
                onclick={onCancel}
                disabled={saving}
            >
                Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
                {actionLabel}
            </Button>
        </div>
    </form>
{/if}
