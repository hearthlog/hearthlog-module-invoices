<script lang="ts">
    import IconSearch from '~icons/mdi/magnify';
    import IconContentCopy from '~icons/mdi/content-copy';
    import IconArrowDown from '~icons/mdi/arrow-down';
    import IconArrowUp from '~icons/mdi/arrow-up';
    import IconUnfoldMore from '~icons/mdi/unfold-more-horizontal';
    import { DataPlaceholder } from "@hearthlog/sdk/ui";
    import { Button } from "@hearthlog/sdk/ui";
    import { Drawer } from "@hearthlog/sdk/ui";
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
    type PartyScope = 'all' | 'customer' | 'supplier' | 'unused';
    type PartySortKey = 'name' | 'ico' | 'city' | 'customer' | 'supplier';
    let scope = $state<PartyScope>('all');
    let sortKey = $state<PartySortKey>('name');
    let sortDesc = $state(false);
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

    const isUnused = (party: InvoicePartySource): boolean => usageCount(party) === 0;
    const SCOPES: Array<{ id: PartyScope; label: string; test: (party: InvoicePartySource) => boolean }> = [
        { id: 'all', label: 'All', test: () => true },
        { id: 'customer', label: 'Customers', test: (party) => (usage.get(party.id)?.customer ?? 0) > 0 },
        { id: 'supplier', label: 'Suppliers', test: (party) => (usage.get(party.id)?.supplier ?? 0) > 0 },
        { id: 'unused', label: 'Unused', test: isUnused },
    ];
    const scopeCounts = $derived(
        Object.fromEntries(SCOPES.map((entry) => [entry.id, filtered.filter(entry.test).length])) as Record<PartyScope, number>,
    );

    function sortValue(party: InvoicePartySource, key: PartySortKey): string | number {
        switch (key) {
            case 'customer': return usage.get(party.id)?.customer ?? 0;
            case 'supplier': return usage.get(party.id)?.supplier ?? 0;
            case 'ico': return party.ico ?? '';
            case 'city': return party.city ?? '';
            default: return party.name;
        }
    }

    /** Filtered by the scope tab and ordered by the chosen column; empty values sort last. */
    const rows = $derived.by(() => {
        const test = SCOPES.find((entry) => entry.id === scope)?.test ?? (() => true);
        const direction = sortDesc ? -1 : 1;
        return filtered.filter(test).sort((left, right) => {
            const a = sortValue(left, sortKey);
            const b = sortValue(right, sortKey);
            if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction || left.name.localeCompare(right.name, 'cs-CZ');
            if (!a && b) return 1;
            if (a && !b) return -1;
            return String(a).localeCompare(String(b), 'cs-CZ') * direction;
        });
    });

    const duplicateIds = $derived(new Set(duplicateGroups.flat().map((party) => party.id)));

    const SORT_COLUMNS: Array<{ key: PartySortKey; label: string; right: boolean }> = [
        { key: 'name', label: 'Name', right: false },
        { key: 'ico', label: 'IČO', right: false },
        { key: 'city', label: 'Address', right: false },
        { key: 'customer', label: 'As customer', right: true },
        { key: 'supplier', label: 'As supplier', right: true },
    ];

    function sortBy(key: PartySortKey): void {
        if (sortKey === key) sortDesc = !sortDesc;
        else {
            sortKey = key;
            sortDesc = key === 'customer' || key === 'supplier';
        }
    }

    function initials(name: string): string {
        return name
            .replace(/[,.]/g, ' ')
            .split(/\s+/)
            .filter((word) => word && !/^(s|r|o|a|a\.s|spol|ltd|gmbh)$/i.test(word))
            .slice(0, 2)
            .map((word) => word[0]!.toLocaleUpperCase('cs-CZ'))
            .join('');
    }

    function sortState(key: PartySortKey): 'ascending' | 'descending' | 'none' {
        return sortKey === key ? (sortDesc ? 'descending' : 'ascending') : 'none';
    }

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
    <section class="stor-panel" style:overflow="visible" aria-label="Party directory">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2.5 px-[var(--stor-panel-padding)] py-3.5">
            <label class="flex h-10 w-full max-w-[19rem] items-center gap-2.5 rounded-[10px] border border-[var(--stor-field-border)] bg-[var(--stor-surface-well)] px-3 text-[var(--stor-muted-text)] focus-within:ring-2 focus-within:ring-[var(--stor-focus)]">
                <IconSearch class="h-4 w-4 shrink-0" />
                <input id="party-search" type="search" aria-label="Search parties" placeholder="Name, IČO, city…" bind:value={search} class="min-w-0 flex-1 bg-transparent text-sm text-[var(--stor-ink)] outline-none placeholder:text-[var(--stor-muted-text)]" />
            </label>
            <div class="stor-segmented-control flex items-center" role="group" aria-label="Show parties used as">
                {#each SCOPES as entry (entry.id)}
                    <button type="button" aria-pressed={scope === entry.id} onclick={() => (scope = entry.id)} class="stor-segmented-option whitespace-nowrap">
                        {entry.label}<span class="stor-tab-count ml-1.5">{scopeCounts[entry.id]}</span>
                    </button>
                {/each}
            </div>
            <span class="ml-auto text-sm text-[var(--stor-muted-text)]" role="status">{rows.length} of {active.length} parties</span>
            {#if editor?.mode !== 'create'}
                <Button size="sm" onclick={() => (editor = { mode: 'create' })}>Add party</Button>
            {/if}
        </div>
        {#if duplicateGroups.length}
            <div class="mx-[var(--stor-panel-padding)] mb-3.5 flex flex-col gap-2" aria-label="Possible duplicate parties">
                {#each duplicateGroups as group (group[0]?.id)}
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-[var(--stor-warning-soft,var(--stor-surface-muted))] px-3.5 py-3 text-sm">
                        <IconContentCopy class="h-4 w-4 shrink-0 text-[var(--stor-warning)]" />
                        <span class="min-w-0 flex-1 text-[var(--stor-ink)]">
                            <strong class="font-semibold">{group.length} records look like one company.</strong>
                            <span class="text-[var(--stor-muted-text)]">{group.map((member) => member.name).join(' · ')}{#if group[0]?.ico} share IČO {group[0].ico}{/if}</span>
                        </span>
                        <Button
                            variant="secondary"
                            size="sm"
                            onclick={() =>
                                (merge = {
                                    members: group,
                                    survivorId: [...group].sort((left, right) => usageCount(right) - usageCount(left))[0]!.id,
                                })}
                        >
                            Review and merge
                        </Button>
                    </div>
                {/each}
            </div>
        {/if}
    {#if merge}
        <section class="mx-[var(--stor-panel-padding)] mb-3.5 rounded-xl bg-[var(--stor-surface-muted)] p-4" aria-label="Merge parties">
            <h2 class="stor-panel-title">Merge duplicate parties</h2>
            <p class="mt-1 text-xs text-[var(--stor-muted-text)]">
                Choose the record to keep. The others become aliases, and existing invoices still resolve.
            </p>
            <div class="mt-3 space-y-2">
                {#each merge.members as member (member.id)}
                    <label class="flex items-start gap-2 rounded-xl bg-[var(--stor-surface)] p-3 text-sm shadow-[var(--stor-shadow-sm)]">
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

    {#if rows.length === 0}
        <div class="border-t border-[var(--stor-border)] px-6 py-12 text-center">
            <p class="font-semibold text-[var(--stor-ink)]">{active.length === 0 ? 'No parties yet' : 'No matching parties'}</p>
            <p class="mt-1 text-sm text-[var(--stor-muted-text)]">
                {active.length === 0
                    ? 'Add the companies you bill or buy from; one record serves both sides of an invoice.'
                    : 'Adjust the search or the filter to find a company.'}
            </p>
        </div>
    {:else}
        <div class="overflow-x-auto">
            <table class="w-full min-w-[56rem] table-fixed border-collapse text-left text-sm" aria-label="Party directory">
                <colgroup>
                    <col />
                    <col class="w-28" />
                    <col class="w-[15rem]" />
                    <col class="w-28" />
                    <col class="w-28" />
                    <col class="w-48" />
                </colgroup>
                <thead class="stor-overline bg-[var(--stor-surface-muted)]">
                    <tr class="h-[38px]">
                        {#each SORT_COLUMNS as column (column.key)}
                            <th scope="col" class="border-y border-[var(--stor-border)] px-4 {column.right ? 'text-right' : ''}" aria-sort={sortState(column.key)}>
                                <button type="button" onclick={() => sortBy(column.key)} class="inline-flex items-center gap-1 font-[inherit] [text-transform:inherit] hover:text-[var(--stor-accent-strong)] focus-visible:outline-2 focus-visible:outline-[var(--stor-focus)]" aria-label={`Sort by ${column.label}`}>
                                    {column.label}
                                    {#if sortKey === column.key}
                                        {#if sortDesc}<IconArrowDown class="h-3.5 w-3.5" />{:else}<IconArrowUp class="h-3.5 w-3.5" />{/if}
                                    {:else}<IconUnfoldMore class="h-3.5 w-3.5 opacity-50" />{/if}
                                </button>
                            </th>
                        {/each}
                        <th scope="col" class="border-y border-[var(--stor-border)] px-4"><span class="sr-only">Actions</span></th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-[color-mix(in_srgb,var(--stor-border)_55%,transparent)]">
                    {#each rows as party (party.id)}
                        {@const entry = usage.get(party.id)}
                        <tr class="group h-16 transition-colors hover:bg-[var(--stor-surface-muted)]/70 {selectedId === party.id ? 'bg-[var(--stor-accent-soft)]' : ''}">
                            <td class="px-4 py-2">
                                <button
                                    type="button"
                                    data-party-open={party.id}
                                    aria-label={`View party ${party.name}`}
                                    aria-current={selectedId === party.id ? 'true' : undefined}
                                    onclick={() => (selectedId = party.id)}
                                    class="flex w-full min-w-0 items-center gap-3 text-left"
                                >
                                    <span class="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] bg-[var(--stor-surface-muted)] text-xs font-semibold tracking-wide text-[var(--stor-muted-text)] shadow-[inset_0_0_0_1px_var(--stor-border)]" aria-hidden="true">{initials(party.name)}</span>
                                    <span class="flex min-w-0 flex-col">
                                        <span class="truncate font-medium text-[var(--stor-ink)] group-hover:underline group-hover:decoration-[var(--stor-border-strong)] group-hover:underline-offset-4">
                                            {party.name}
                                            {#if duplicateIds.has(party.id)}<span class="ml-2 rounded-full bg-[var(--stor-warning-soft,var(--stor-surface-muted))] px-1.5 py-0.5 align-[1px] text-[11px] font-semibold text-[var(--stor-warning)]">Duplicate?</span>{/if}
                                        </span>
                                        <span class="truncate text-xs text-[var(--stor-muted-text)]">{party.dic ? `DIČ ${party.dic}` : 'No VAT ID'}</span>
                                    </span>
                                </button>
                            </td>
                            <td class="whitespace-nowrap px-4 py-2 tabular-nums text-[var(--stor-muted-text)]">{party.ico || '—'}</td>
                            <td class="px-4 py-2">
                                <span class="block truncate">{party.street || '—'}</span>
                                {#if party.city}<span class="block truncate text-xs text-[var(--stor-muted-text)]">{party.city}</span>{/if}
                            </td>
                            <td class="px-4 py-2 text-right tabular-nums {entry?.customer ? 'font-semibold' : 'text-[var(--stor-faint-text)]'}">{entry?.customer || '—'}</td>
                            <td class="px-4 py-2 text-right tabular-nums {entry?.supplier ? 'font-semibold' : 'text-[var(--stor-faint-text)]'}">{entry?.supplier || '—'}</td>
                            <td class="px-4 py-2 text-right">
                                <div class="flex justify-end gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                                    <Button variant="secondary" size="sm" onclick={() => (editor = { mode: 'edit', party })}>Edit</Button>
                                    <Button variant="secondary" size="sm" onclick={() => (removal = party)}>Remove</Button>
                                </div>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}
    <p class="border-t border-[var(--stor-border)] px-[var(--stor-panel-padding)] py-3 text-xs text-[var(--stor-muted-text)]">One company record serves both invoice slots. Issued documents keep the details they were saved with.</p>
    </section>
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
