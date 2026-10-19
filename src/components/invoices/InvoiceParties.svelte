<script lang="ts">
    import IconAccountGroup from '~icons/mdi/account-multiple-outline';
    import { EmptyState } from "@hearthlog/sdk/ui";
    import { DataPlaceholder } from "@hearthlog/sdk/ui";
    import { Button } from "@hearthlog/sdk/ui";
    import { Drawer } from "@hearthlog/sdk/ui";
    import { Field } from "@hearthlog/sdk/ui";
    import { Input } from "@hearthlog/sdk/ui";
    import { CommandConfirmDialog } from "@hearthlog/sdk/ui";
    import InvoiceDetailCard from './InvoiceDetailCard.svelte';
    import InvoicePartyForm from './InvoicePartyForm.svelte';
    import type { InvoicePartyDraft } from './InvoicePartyForm.svelte';
    import { executeLocalCommand } from '@hearthlog/sdk/data';
    import { queryDatabase } from '@hearthlog/sdk/data';
    import type { ExtendedAppEvent } from '@hearthlog/sdk/data';
    import { activeParties, resolveDirectoryParty, type InvoicePartySource } from '../../invoices/document.js';
    import { normalizeIco, normalizePartyName } from '../../invoices/duplicates.js';
    import { refreshPageData } from '@hearthlog/sdk/runtime';
    import { notify } from '@hearthlog/sdk/runtime';
    import type { Invoice, ReceivedInvoice } from '../../data/invoices.js';

    /**
     * The party directory. One company record serves both invoice slots; a
     * merged duplicate stays as a hidden alias so old references still resolve.
     */
    let {
        parties = [],
        revision = 0,
        loading = false,
        onCreateParty,
        onUpdateParty,
    }: {
        parties?: InvoicePartySource[];
        revision?: number;
        loading?: boolean;
        onCreateParty: (
            draft: InvoicePartyDraft,
        ) => Promise<{ id: string; name: string } | null>;
        onUpdateParty: (
            draft: InvoicePartyDraft,
        ) => Promise<{ id: string; name: string } | null>;
    } = $props();

    let search = $state('');
    let editor = $state<
        { mode: 'create' } | { mode: 'edit'; party: InvoicePartySource } | null
    >(null);
    /** The record shown in the details drawer, if any. */
    let selectedId = $state<string | null>(null);
    let removal = $state<InvoicePartySource | null>(null);
    let merge = $state<{
        members: InvoicePartySource[];
        survivorId: string;
    } | null>(null);
    let savingMerge = $state(false);

    // Invoice references decide the "used as" badges and the delete warning.
    let invoices = $state<Invoice[]>([]);
    let receivedInvoices = $state<ReceivedInvoice[]>([]);
    let usageLoading = $state(true);

    $effect(() => {
        void revision;
        let cancelled = false;
        usageLoading = true;
        queryDatabase(async (repositories) => ({
            issued: await repositories.invoices.getInvoices(),
            received: await repositories.invoices.getReceivedInvoices(),
        }))
            .then((result) => {
                if (cancelled) return;
                invoices = result.issued;
                receivedInvoices = result.received;
            })
            .catch(() => undefined)
            .finally(() => {
                if (!cancelled) usageLoading = false;
            });
        return () => {
            cancelled = true;
        };
    });

    const active = $derived(activeParties(parties));
    // The details drawer follows the directory, so a rename or merge is
    // reflected without re-opening it, and a removed record closes it.
    const selected = $derived(
        active.find((party) => party.id === selectedId) ?? null,
    );

    /** Invoice references per surviving party, split by the slot used. */
    const usage = $derived.by(() => {
        const counts = new Map<string, { supplier: number; customer: number }>();
        const bump = (
            id: string | null | undefined,
            side: 'supplier' | 'customer',
        ): void => {
            const survivor = resolveDirectoryParty(parties, id)?.id;
            if (!survivor) return;
            const entry = counts.get(survivor) ?? { supplier: 0, customer: 0 };
            entry[side] += 1;
            counts.set(survivor, entry);
        };
        for (const invoice of invoices) {
            bump(invoice.supplier_id, 'supplier');
            bump(invoice.customer_id, 'customer');
        }
        for (const invoice of receivedInvoices) bump(invoice.supplier_id, 'supplier');
        return counts;
    });

    /**
     * Active records that share an IČO or a normalized name, unioned so a
     * name-only twin and an IČO twin land in the same group.
     */
    const duplicateGroups = $derived.by(() => {
        const parent = new Map<string, string>();
        const find = (id: string): string => {
            let root = id;
            while (parent.get(root) && parent.get(root) !== root) {
                root = parent.get(root)!;
            }
            return root;
        };
        const union = (left: string, right: string): void => {
            const rootLeft = find(left);
            const rootRight = find(right);
            if (rootLeft !== rootRight) parent.set(rootRight, rootLeft);
        };
        const byKey = new Map<string, string>();
        for (const party of active) {
            parent.set(party.id, parent.get(party.id) ?? party.id);
            const keys = [
                normalizeIco(party.ico) ? `ico:${normalizeIco(party.ico)}` : '',
                normalizePartyName(party.name) ? `name:${normalizePartyName(party.name)}` : '',
            ].filter(Boolean);
            for (const key of keys) {
                const first = byKey.get(key);
                if (first) union(first, party.id);
                else byKey.set(key, party.id);
            }
        }
        const groups = new Map<string, InvoicePartySource[]>();
        for (const party of active) {
            const root = find(party.id);
            const members = groups.get(root) ?? [];
            members.push(party);
            groups.set(root, members);
        }
        return [...groups.values()].filter((members) => members.length > 1);
    });

    const filtered = $derived.by(() => {
        const needle = search.trim().toLocaleLowerCase('cs-CZ');
        if (!needle) return active;
        return active.filter((party) =>
            [party.name, party.ico, party.city, party.dic]
                .filter(Boolean)
                .some((value) =>
                    String(value).toLocaleLowerCase('cs-CZ').includes(needle),
                ),
        );
    });

    /** The details drawer's invoice references, one line per slot. */
    const selectedUsage = $derived.by((): string[] => {
        const party = selected;
        if (!party) return [];
        const entry = usage.get(party.id);
        if (!entry) return [];
        const lines: string[] = [];
        if (entry.supplier) {
            lines.push(
                `${entry.supplier} invoice${entry.supplier === 1 ? '' : 's'} as supplier`,
            );
        }
        if (entry.customer) {
            lines.push(
                `${entry.customer} invoice${entry.customer === 1 ? '' : 's'} as customer`,
            );
        }
        return lines;
    });

    function usageLabel(party: InvoicePartySource): string {
        const entry = usage.get(party.id);
        if (!entry) return 'Unused';
        const parts: string[] = [];
        if (entry.supplier) parts.push(`${entry.supplier}× supplier`);
        if (entry.customer) parts.push(`${entry.customer}× customer`);
        return parts.join(' · ');
    }

    function usageCount(party: InvoicePartySource): number {
        const entry = usage.get(party.id);
        return entry ? entry.supplier + entry.customer : 0;
    }

    // The page-level handlers already notify; closing the editor is all that
    // is left here.
    async function saveCreated(draft: InvoicePartyDraft) {
        const saved = await onCreateParty(draft);
        if (!saved) return null;
        editor = null;
        return saved;
    }

    async function saveEdited(draft: InvoicePartyDraft) {
        const saved = await onUpdateParty(draft);
        if (!saved) return null;
        editor = null;
        return saved;
    }

    async function removeParty(): Promise<void> {
        const target = removal;
        removal = null;
        if (!target) return;
        try {
            await executeLocalCommand({
                id: crypto.randomUUID(),
                type: 'INVOICEPARTY_REMOVED',
                timestamp: Date.now(),
                payload: { id: target.id },
            });
            if (selectedId === target.id) selectedId = null;
            await refreshPageData('app:invoices');
            notify.success('Party removed');
        } catch {
            notify.error('The party could not be removed.');
        }
    }

    /**
     * Merges every other member into the chosen survivor with one alias event
     * each: old invoice references resolve forward and stay undoable.
     */
    async function mergeGroup(): Promise<void> {
        const target = merge;
        if (!target || savingMerge) return;
        savingMerge = true;
        try {
            const losers = target.members.filter(
                (party) => party.id !== target.survivorId,
            );
            const events = losers.map(
                (party): ExtendedAppEvent => ({
                    id: crypto.randomUUID(),
                    type: 'INVOICEPARTY_UPDATED',
                    timestamp: Date.now(),
                    payload: { id: party.id, merged_into: target.survivorId },
                }),
            );
            await executeLocalCommand(events);
            await refreshPageData('app:invoices');
            merge = null;
            notify.success(
                losers.length === 1
                    ? 'Duplicate party merged'
                    : `${losers.length} duplicate parties merged`,
            );
        } catch {
            notify.error('The parties could not be merged.');
        } finally {
            savingMerge = false;
        }
    }
</script>

{#if loading || usageLoading}
    <section class="stor-panel p-[var(--stor-panel-padding)]" aria-label="Loading parties">
        <DataPlaceholder rows={5} label="Loading parties" />
    </section>
{:else}
    <section class="stor-panel p-[var(--stor-panel-padding)]" aria-label="Party filters">
        <div class="stor-panel-header-flush flex flex-wrap items-end gap-x-4 gap-y-3">
            <div class="min-w-0 flex-1">
                <h2 class="stor-panel-title">Parties</h2>
                <p class="mt-1 text-xs text-[var(--stor-muted-text)]">
                    One company record serves both invoice slots · {active.length} record{active.length === 1 ? '' : 's'}
                </p>
            </div>
            <div class="w-full sm:w-64">
                <Field label="Search" htmlFor="party-search">
                    <Input id="party-search" placeholder="Name, IČO, city…" bind:value={search} />
                </Field>
            </div>
            {#if editor?.mode !== 'create'}
                <Button size="sm" onclick={() => (editor = { mode: 'create' })}>Add party</Button>
            {/if}
        </div>
    </section>

    {#if duplicateGroups.length}
        <section class="stor-panel" aria-label="Possible duplicate parties">
            <div class="stor-panel-header stor-panel-header-rule">
                <div class="min-w-0">
                    <h2 class="stor-panel-title">Possible duplicates</h2>
                    <p class="mt-0.5 text-xs text-[var(--stor-muted-text)]">
                        Records sharing an IČO or name · merge keeps one record and points the rest at it
                    </p>
                </div>
            </div>
            <div class="space-y-3 px-[var(--stor-panel-padding)] pb-[var(--stor-panel-padding)]">
                {#each duplicateGroups as group (group[0]?.id)}
                    <div class="rounded-xl bg-[var(--stor-surface-muted)] p-3">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <p class="text-sm font-semibold text-[var(--stor-ink)]">
                                {group.length} records · {group[0]?.name}
                            </p>
                            <Button
                                variant="secondary"
                                size="sm"
                                onclick={() =>
                                    (merge = {
                                        members: group,
                                        survivorId:
                                            [...group].sort(
                                                (left, right) =>
                                                    usageCount(right) - usageCount(left),
                                            )[0]!.id,
                                    })}
                            >
                                Merge…
                            </Button>
                        </div>
                        <ul class="mt-2 space-y-1 text-xs text-[var(--stor-muted-text)]">
                            {#each group as member (member.id)}
                                <li>
                                    {member.name}{#if member.ico} · IČO {member.ico}{/if}
                                    {#if member.city} · {member.city}{/if}
                                    · {usageLabel(member)}
                                </li>
                            {/each}
                        </ul>
                    </div>
                {/each}
            </div>
        </section>
    {/if}

    {#if merge}
        <section class="stor-panel p-[var(--stor-panel-padding)]" aria-label="Merge parties">
            <h2 class="stor-panel-title">Merge duplicate parties</h2>
            <p class="mt-1 text-xs text-[var(--stor-muted-text)]">
                Choose the record to keep. The others become aliases, and existing invoices still resolve.
            </p>
            <div class="mt-3 space-y-2">
                {#each merge.members as member (member.id)}
                    <label class="flex items-start gap-2 rounded-xl border border-[var(--stor-border)] p-3 text-sm">
                        <input
                            type="radio"
                            name="merge-survivor"
                            class="mt-0.5"
                            checked={merge.survivorId === member.id}
                            onchange={() => (merge = merge ? { ...merge, survivorId: member.id } : null)}
                        />
                        <span class="min-w-0">
                            <span class="block font-semibold text-[var(--stor-ink)]">{member.name}{#if member.ico} · IČO {member.ico}{/if}</span>
                            <span class="block text-xs text-[var(--stor-muted-text)]">
                                {[member.street, member.city].filter(Boolean).join(', ')} · {usageLabel(member)}
                            </span>
                        </span>
                    </label>
                {/each}
            </div>
            <div class="mt-3 flex justify-end gap-2">
                <Button variant="secondary" size="sm" onclick={() => (merge = null)}>Cancel</Button>
                <Button size="sm" disabled={savingMerge} onclick={() => void mergeGroup()}>
                    {savingMerge ? 'Merging…' : 'Merge duplicates'}
                </Button>
            </div>
        </section>
    {/if}

    {#if active.length === 0}
        <EmptyState
            icon={IconAccountGroup}
            title="No parties yet"
            description="Add the companies you bill or buy from; one record serves both sides of an invoice."
        />
    {:else if filtered.length === 0}
        <EmptyState
            icon={IconAccountGroup}
            title="No matching parties"
            description="Adjust the search to find a company."
        />
    {:else}
        <section class="stor-panel" aria-label="Party directory">
            <div class="overflow-x-auto">
                <table class="w-full min-w-[46rem] border-collapse text-left text-sm" aria-label="Party directory">
                    <thead class="bg-[var(--stor-surface-muted)] text-xs text-[var(--stor-muted-text)]">
                        <tr>
                            <th scope="col" class="px-3 py-3">Name</th>
                            <th scope="col" class="px-3 py-3">IČO</th>
                            <th scope="col" class="px-3 py-3">Address</th>
                            <th scope="col" class="px-3 py-3">Used as</th>
                            <th scope="col" class="px-3 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-[var(--stor-border)]">
                        {#each filtered as party (party.id)}
                            <tr>
                                <td class="px-3 py-3">
                                    <button
                                        type="button"
                                        data-party-open={party.id}
                                        aria-label={`View party ${party.name}`}
                                        aria-current={selectedId === party.id ? 'true' : undefined}
                                        onclick={() => (selectedId = party.id)}
                                        class="text-left font-semibold text-[var(--stor-ink)] hover:underline"
                                    >
                                        {party.name}
                                        {#if party.dic}<span class="ml-1 text-xs text-[var(--stor-muted-text)]">DIČ {party.dic}</span>{/if}
                                    </button>
                                </td>
                                <td class="whitespace-nowrap px-3 py-3 tabular-nums text-[var(--stor-muted-text)]">{party.ico || '—'}</td>
                                <td class="px-3 py-3 text-[var(--stor-muted-text)]">{[party.street, party.city].filter(Boolean).join(', ') || '—'}</td>
                                <td class="whitespace-nowrap px-3 py-3 text-[var(--stor-muted-text)]">{usageLabel(party)}</td>
                                <td class="whitespace-nowrap px-3 py-3 text-right">
                                    <Button variant="secondary" size="sm" onclick={() => (editor = { mode: 'edit', party })}>Edit</Button>
                                    <Button variant="secondary" size="sm" onclick={() => (removal = party)}>Remove</Button>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        </section>
    {/if}
{/if}

<Drawer
    show={selected !== null && editor === null}
    title={selected?.name ?? 'Party'}
    description={selected ? usageLabel(selected) : ''}
    onClose={() => (selectedId = null)}
>
    {#if selected}
        {@const party = selected}
        <section class="grid gap-3 sm:grid-cols-2" aria-label="Party details">
            <InvoiceDetailCard
                label="Address"
                details={[party.street, party.city].filter(Boolean)}
                emptyText="Not set"
            />
            <InvoiceDetailCard
                label="Company ID (IČO)"
                title={party.ico}
                emptyText="Not set"
            />
            <InvoiceDetailCard
                label="VAT ID (DIČ)"
                title={party.dic ?? ''}
                emptyText="Not set"
            />
            <InvoiceDetailCard
                label="Bank account"
                title={party.bank_account ?? ''}
                emptyText="Not set"
            />
            <InvoiceDetailCard
                label="Registration footer"
                details={party.registration ? [party.registration] : []}
                emptyText="Not set"
            />
            <InvoiceDetailCard
                label="Used on invoices"
                details={selectedUsage}
                emptyText="Not used on any invoice yet"
            />
        </section>
    {/if}
    {#snippet footer()}
        {#if selected}
            <Button
                variant="secondary"
                size="sm"
                onclick={() => (removal = selected)}
            >
                Remove
            </Button>
            <Button
                size="sm"
                onclick={() => (editor = { mode: 'edit', party: selected })}
            >
                Edit party
            </Button>
        {/if}
    {/snippet}
</Drawer>

<InvoicePartyForm
    variant="drawer"
    show={editor !== null}
    initial={editor?.mode === 'edit' ? editor.party : undefined}
    title={editor?.mode === 'edit' ? 'Edit party' : 'New party'}
    description={editor?.mode === 'edit'
        ? 'Update the directory record; issued documents keep their saved details.'
        : 'Add a company to the directory; one record serves both invoice slots.'}
    onSave={editor?.mode === 'edit' ? saveEdited : saveCreated}
    onSaved={() => (editor = null)}
    onCancel={() => (editor = null)}
/>

<CommandConfirmDialog
    show={removal !== null}
    title="Remove party?"
    message={removal
        ? `${removal.name} is referenced by ${usageCount(removal)} invoice${usageCount(removal) === 1 ? '' : 's'}; their document snapshots keep the details, so issued invoices stay readable.`
        : ''}
    confirmLabel="Remove party"
    onConfirm={() => void removeParty()}
    onCancel={() => (removal = null)}
/>
