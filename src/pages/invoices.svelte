<script lang="ts">
    import IconPlus from "~icons/mdi/plus";
    import IconUpload from "~icons/mdi/upload-outline";
    import { PageHeader } from "@hearthlog/sdk/ui";
    import { Button } from "@hearthlog/sdk/ui";
    import { MobilePageAction } from "@hearthlog/sdk/ui";
    import { tabIndicator } from "@hearthlog/sdk/ui";
    import { Drawer } from "@hearthlog/sdk/ui";
    import { providePageResource } from "@hearthlog/sdk/runtime";
    import { PageDataStatus } from "@hearthlog/sdk/ui";
    import { executeLocalCommand } from "@hearthlog/sdk/data";
    import { browser } from '$app/env';
    import { goto } from "$app/navigation";
    import { refreshPageData as invalidate } from "@hearthlog/sdk/runtime";
    import { page } from "$app/state";
    import { Tabs } from "bits-ui";
    import type { Invoice } from "../data/invoices.js";
    import { queryDatabase } from "@hearthlog/sdk/data";
    import { CommandConfirmDialog } from "@hearthlog/sdk/ui";
    import { CommandOnly } from "@hearthlog/sdk/ui";
    import InvoiceDrawer, {
        type InvoiceDraft,
    } from "../components/invoices/InvoiceDrawer.svelte";
    import InvoiceActionsMenu from "../components/invoices/InvoiceActionsMenu.svelte";
    import InvoiceDetailPanel from "../components/invoices/InvoiceDetailPanel.svelte";
    import InvoiceListPanel from "../components/invoices/InvoiceListPanel.svelte";
    import InvoiceOverview from "../components/invoices/InvoiceOverview.svelte";
    import InvoicePdfViewer from "../components/invoices/InvoicePdfViewer.svelte";
    import ReceivedInvoices from "../components/invoices/ReceivedInvoices.svelte";
    import InvoiceParties from "../components/invoices/InvoiceParties.svelte";
    import InvoiceAnalytics from "../components/invoices/InvoiceAnalytics.svelte";
    import {
        activeParties,
        invoiceDueDate,
        resolveDirectoryParty,
        resolveInvoiceParty,
        type InvoicePartySource,
    } from "../invoices/document.js";
    import { isInvoiceOverdue, invoiceToday } from "../invoices/filters.js";
    import { emptyInvoiceFilters, type InvoiceListRow, type InvoiceSelection } from "../invoices/list-contracts.js";
    import type { ExtendedAppEvent } from '@hearthlog/sdk/data';
    import type { InvoicePartyDraft } from '../components/invoices/InvoicePartyForm.svelte';
    import { invoiceRouteState, navigateInvoices } from '../invoices/url.js';
    import { queueInvoicePdfDeletion } from '../api/invoice-pdf-cache.js';
    import {
        discardQueuedIssuedFile,
        queueIssuedIsdoc,
        queueIssuedPdf,
        runIssuedFileUploads,
        validateIssuedPdf,
    } from '../invoices/issued-file-store.js';
    import {
        duplicatePromptMessage,
        findDuplicates,
        findPartyMatch,
        issuedDuplicateCandidate,
        normalizeInvoiceNumber,
        partyIdentityFromSnapshot,
        partyMatchMessage,
        type DuplicateInvoice,
        type DuplicateTarget,
    } from '../invoices/duplicates.js';
    import { notify } from '@hearthlog/sdk/runtime';
    import { appClock } from '@hearthlog/sdk/runtime';
    import { MediaQuery } from 'svelte/reactivity';
    import {
        runCommandAction as runWorkspaceCommandAction,
    } from '@hearthlog/sdk/runtime';

    let { data: routeData } = $props();
    const resource = $derived(routeData.pageResource);
    const data = $derived(resource.data);
    providePageResource(() => resource);
    function runCommandAction(action: () => void): boolean {
        return !resource.loading && runWorkspaceCommandAction(action);
    }

    const invoiceTab = $derived(invoiceRouteState().tab);
    const today = $derived(invoiceToday(appClock.now()));
    let uploadRequested = $state(0);

    // The directory keeps merged aliases so old invoice references resolve;
    // pickers and listings filter to the active records, while resolution and
    // the party panel still see the aliases.
    let parties = $derived<InvoicePartySource[]>(data.parties || []);
    const activeDirectory = $derived(activeParties(parties));

    // Existing invoices the current save would duplicate; resolved by the
    // confirmation dialog before the command is dispatched.
    let duplicatePrompt = $state<{
        matches: DuplicateInvoice[];
        resolve: (proceed: boolean) => void;
    } | null>(null);

    function promptDuplicate(matches: DuplicateInvoice[]): Promise<boolean> {
        return new Promise((resolve) => {
            duplicatePrompt = { matches, resolve };
        });
    }

    function resolveDuplicate(proceed: boolean): void {
        const prompt = duplicatePrompt;
        duplicatePrompt = null;
        prompt?.resolve(proceed);
    }

    // A new party that matches an existing directory record; the dialog offers
    // "Use existing" (confirm), "Create anyway" (alternate) or cancel.
    let partyMatchPrompt = $state<{
        match: InvoicePartySource;
        resolve: (choice: "existing" | "create" | "cancel") => void;
    } | null>(null);

    function promptPartyMatch(
        match: InvoicePartySource,
    ): Promise<"existing" | "create" | "cancel"> {
        return new Promise((resolve) => {
            partyMatchPrompt = { match, resolve };
        });
    }

    function resolvePartyMatch(choice: "existing" | "create" | "cancel"): void {
        const prompt = partyMatchPrompt;
        partyMatchPrompt = null;
        prompt?.resolve(choice);
    }

    /**
     * Existing issued invoices that share this save's number; the counterparty
     * is narrowed in memory because stored names and IČOs are free-form and
     * the normalized number is only the coarse lookup.
     */
    async function findIssuedDuplicates(
        target: DuplicateTarget,
    ): Promise<DuplicateInvoice[]> {
        const number = normalizeInvoiceNumber(target.invoiceNumber);
        if (!number) return [];
        const rows = await queryDatabase((repositories) =>
            repositories.invoices.findInvoicesByNumber(number),
        );
        return findDuplicates(
            { ...target, invoiceNumber: number },
            rows.map((row) => issuedDuplicateCandidate(row, parties)),
        );
    }

    function selectInvoiceTab(tab: 'issued' | 'received' | 'analytics' | 'parties') {
        uploadRequested = 0;
        // Each direction has its own rows and filters, and the selected invoice
        // belongs to the current direction only.
        navigateInvoices({ tab, invoice: null, view: 'details' }, 'push');
    }

    // --- Selection & view state (kept in the URL) ---
    // `invoice` selects the row shown in the detail drawer and `view` switches
    // between its details and the rendered PDF, so both survive reloads and
    // the browser Back button.
    const selectedInvoiceId = $derived(invoiceRouteState().invoice);
    const invoiceView = $derived(invoiceRouteState().view);

    // --- The drawer reads one whole record ---
    // The list carries a SQL projection, so the selected invoice is read by id
    // and cached for instant re-opening. A plain Map keeps the cache out of
    // reactivity so filling it cannot retrigger the effect that reads it.
    const invoiceCache = new Map<string, Invoice>();
    let selectedInvoice = $state<Invoice | null>(null);

    async function loadInvoice(id: string, options: { refresh?: boolean } = {}): Promise<Invoice | null> {
        const cached = invoiceCache.get(id);
        if (cached && !options.refresh) return cached;
        const invoice = await queryDatabase((repositories) => repositories.invoices.getInvoice(id));
        if (invoice) invoiceCache.set(invoice.id, invoice);
        return invoice ?? cached ?? null;
    }

    $effect(() => {
        const id = selectedInvoiceId;
        void resource.revision;
        if (!id || invoiceTab !== 'issued') {
            selectedInvoice = null;
            return;
        }
        // Paint the cached copy, then refresh it so an edit is reflected.
        selectedInvoice = invoiceCache.get(id) ?? null;
        let cancelled = false;
        loadInvoice(id, { refresh: true })
            .then((invoice) => {
                if (cancelled || !invoice) return;
                if (invoiceRouteState().invoice === invoice.id) selectedInvoice = invoice;
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    });

    /**
     * Select an invoice for the detail drawer. Tapping a row pushes history so
     * Back returns to the list; switching between rows replaces it. Switching
     * to another invoice always resets the drawer to its details.
     */
    function selectInvoice(
        row: InvoiceListRow,
        options: { view?: "details" | "pdf"; history?: "push" | "replace" } = {},
    ): void {
        const history =
            options.history ??
            (selectedInvoiceId === null ? "push" : "replace");
        navigateInvoices({ invoice: row.id, view: options.view ?? "details" }, history);
    }

    function showInvoicePdf(row: InvoiceListRow): void {
        selectInvoice(row, { view: "pdf" });
    }

    function selectInvoiceView(view: "details" | "pdf"): void {
        if (!selectedInvoiceId) return;
        navigateInvoices({ view });
    }

    function clearInvoiceSelection(): void {
        navigateInvoices({ invoice: null, view: "details" });
    }

    let isAddingInvoice = $state(false);
    let isImportingInvoice = $state(false);
    let handledNewInvoiceUrl = $state("");
    let editingInvoice = $state<Invoice | null>(null);
    let cloningInvoice = $state<Invoice | null>(null);

    // --- Confirm Dialog ---
    let showConfirmDialog = $state(false);
    let confirmTitle = $state('Delete invoice?');
    let confirmMessage = $state("");
    let confirmAction = $state<(() => Promise<void>) | null>(null);

    async function saveInvoice(draft: InvoiceDraft) {
        // Warn before saving a record that would repeat an existing invoice
        // number for the same customer; the user can still save it again.
        const snapshotCustomer = partyIdentityFromSnapshot(draft.customerSnapshot);
        const directoryCustomer = draft.customerId
            ? parties.find((party) => party.id === draft.customerId)
            : undefined;
        const duplicateMatches = await findIssuedDuplicates({
            id: editingInvoice?.id ?? null,
            invoiceNumber: draft.invoiceNumber,
            partyName: snapshotCustomer.name || directoryCustomer?.name,
            partyIco: snapshotCustomer.ico || directoryCustomer?.ico,
        });

        if (duplicateMatches.length && !await promptDuplicate(duplicateMatches)) return;

        const amount = draft.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
        const invoiceId = editingInvoice?.id ?? crypto.randomUUID();
        // The due date is not entered directly: the form collects a payment
        // term in days from the issue date and the date is derived here.
        const dueDate = invoiceDueDate(draft.issueDate, draft.paymentTermDays);
        const documentFields = {
            document_state: draft.documentState,
            // Document identity is internal plumbing, not form input: the
            // invoice id is a UUID and the renderer derives a stable document
            // UUID from it. Preserve an existing UUID/reference on edit.
            document_uuid: editingInvoice?.document_uuid || invoiceId,
            vat_applicable: draft.vatApplicable ? draft.vatApplicable === "true" : null,
            electronic_agreement_reference: editingInvoice?.electronic_agreement_reference ?? "",
            supplier_snapshot: draft.supplierSnapshot ?? "",
            customer_snapshot: draft.customerSnapshot ?? "",
            // Payment instructions come from the supplier account when the
            // document is rendered; clear any legacy per-invoice snapshot.
            payment_snapshot: "",
        };
        try {
            if (editingInvoice) {
                await executeLocalCommand({
                    id: crypto.randomUUID(),
                    type: "INVOICE_UPDATED",
                    timestamp: Date.now(),
                    payload: {
                        id: editingInvoice.id,
                        ...documentFields,
                        invoice_number: draft.invoiceNumber,
                        amount,
                        supplier_id: draft.supplierId,
                        customer_id: draft.customerId,
                        description: draft.description,
                        issue_date: new Date(
                            `${draft.issueDate}T12:00:00`,
                        ).toISOString(),
                        due_date: new Date(`${dueDate}T12:00:00`).toISOString(),
                        tax_point_date: new Date(
                            `${draft.taxPointDate}T12:00:00`,
                        ).toISOString(),
                        items: JSON.stringify(draft.items),
                    },
                });
                await invalidate("app:invoices");
                editingInvoice = null;
                notify.success("Invoice updated");
                return;
            }

            const wasClone = cloningInvoice !== null;
            const attachment = draft.import ?? null;
            const queuedScopes: Array<Awaited<ReturnType<typeof queueIssuedPdf>>> = [];
            // Imported originals are queued before the command so a failed save
            // can discard them again; the ids are part of the invoice record.
            const importFields = attachment
                ? {
                      file_id: crypto.randomUUID(),
                      file_name: attachment.file.name,
                      size_bytes: attachment.file.size,
                      storage_status: "queued",
                      isdoc_file_id: attachment.isdocXml ? crypto.randomUUID() : "",
                      isdoc_file_name: attachment.isdocXml ? attachment.isdocName || "invoice.isdoc" : "",
                      isdoc_size_bytes: attachment.isdocXml ? new TextEncoder().encode(attachment.isdocXml).byteLength : 0,
                      isdoc_storage_status: attachment.isdocXml ? "queued" : "",
                      extraction_source: attachment.source,
                      extraction_metadata: attachment.metadata,
                  }
                : {};
            try {
                if (attachment) {
                    await validateIssuedPdf(attachment.file);
                    queuedScopes.push(await queueIssuedPdf(invoiceId, String(importFields.file_id), attachment.file));
                    if (attachment.isdocXml) {
                        queuedScopes.push(await queueIssuedIsdoc(
                            invoiceId,
                            String(importFields.isdoc_file_id),
                            new File([attachment.isdocXml], String(importFields.isdoc_file_name), { type: "application/xml;charset=utf-8" }),
                        ));
                    }
                }
                await executeLocalCommand({
                    id: crypto.randomUUID(),
                    type: "INVOICE_ADDED",
                    timestamp: Date.now(),
                    payload: {
                        id: invoiceId,
                        ...documentFields,
                        ...importFields,
                        invoice_number: draft.invoiceNumber,
                        amount,
                        supplier_id: draft.supplierId,
                        customer_id: draft.customerId,
                        description: draft.description,
                        issue_date: new Date(
                            `${draft.issueDate}T12:00:00`,
                        ).toISOString(),
                        due_date: new Date(`${dueDate}T12:00:00`).toISOString(),
                        tax_point_date: new Date(
                            `${draft.taxPointDate}T12:00:00`,
                        ).toISOString(),
                        // An imported document was already issued elsewhere.
                        status: attachment ? "sent" : "draft",
                        items: JSON.stringify(draft.items),
                    },
                });

                await invalidate("app:invoices");
                isAddingInvoice = false;
                isImportingInvoice = false;
                cloningInvoice = null;
                if (attachment) void runIssuedFileUploads();
                notify.success(
                    attachment
                        ? "Invoice imported"
                        : wasClone
                          ? "Invoice cloned"
                          : "Invoice created",
                );
            } catch (error) {
                for (const scope of queuedScopes) await discardQueuedIssuedFile(scope);
                throw error;
            }
        } catch (error) {
            console.error("Failed to save invoice:", error);
            throw new Error(
                editingInvoice
                    ? "Could not update the invoice. Your values were kept."
                    : "Could not create the invoice. Your values were kept.",
                { cause: error },
            );
        }
    }

    /** Command payload fields: a stored NULL becomes an explicit empty string. */
    function partyPayload(draft: InvoicePartyDraft) {
        return {
            name: draft.name,
            street: draft.street,
            city: draft.city,
            ico: draft.ico,
            dic: draft.dic ?? "",
            bank_account: draft.bank_account ?? "",
            registration: draft.registration ?? "",
            postal_address: draft.postal_address ?? "",
        };
    }

    async function createParty(
        draft: InvoicePartyDraft,
    ): Promise<{ id: string; name: string } | null> {
        const match = findPartyMatch(activeDirectory, {
            id: draft.id || null,
            name: draft.name,
            ico: draft.ico,
        });
        if (match) {
            const choice = await promptPartyMatch(match);
            if (choice === "cancel") return null;
            if (choice === "existing") return { id: match.id, name: match.name };
        }
        const id = crypto.randomUUID();
        await executeLocalCommand({
            id: crypto.randomUUID(),
            type: "INVOICEPARTY_ADDED",
            timestamp: Date.now(),
            // Keep the generated id: the draft carries the editor's empty id.
            payload: { id, ...partyPayload(draft) },
        });
        await invalidate("app:invoices");
        notify.success("Party added");
        return { id, name: draft.name };
    }

    /** Directory edits do not rewrite issued documents; snapshots stay put. */
    async function updateParty(
        draft: InvoicePartyDraft,
    ): Promise<{ id: string; name: string } | null> {
        if (!draft.id) return null;
        try {
            await executeLocalCommand({
                id: crypto.randomUUID(),
                type: "INVOICEPARTY_UPDATED",
                timestamp: Date.now(),
                payload: { id: draft.id, ...partyPayload(draft) },
            });
            await invalidate("app:invoices");
            notify.success("Party updated");
            return { id: draft.id, name: draft.name };
        } catch (error) {
            console.error("Failed to update party:", error);
            throw new Error("Could not update the party. Your values were kept.");
        }
    }

    /**
     * Resolve a party snapshot for a status change. A missing or invalid
     * stored snapshot falls back to the current directory; never write a
     * literal "null" snapshot, which would block later document export.
     */
    function resolvePartyForIssue(
        invoice: Invoice,
        role: "supplier" | "customer",
    ): InvoicePartySource | null {
        const id =
            role === "supplier" ? invoice.supplier_id : invoice.customer_id;
        try {
            return resolveInvoiceParty(invoice, parties, role) ?? null;
        } catch {
            return resolveDirectoryParty(parties, id) ?? null;
        }
    }

    async function handleUpdateStatus(invoice: Invoice, newStatus: string) {
        try {
            const issuing = newStatus !== "draft";
            const supplier = issuing
                ? resolvePartyForIssue(invoice, "supplier")
                : null;
            const customer = issuing
                ? resolvePartyForIssue(invoice, "customer")
                : null;
            await executeLocalCommand({
                id: crypto.randomUUID(),
                type: "INVOICE_UPDATED",
                timestamp: Date.now(),
                payload: {
                    id: invoice.id,
                    status: newStatus,
                    ...issuing
                        ? {
                            document_state: "issued",
                            document_uuid: invoice.document_uuid || invoice.id,
                            ...supplier ? { supplier_snapshot: JSON.stringify(supplier) } : {},
                            ...customer ? { customer_snapshot: JSON.stringify(customer) } : {}
                        }
                        : {}
                }
            });

            await invalidate("app:invoices");
            notify.success(`Invoice marked ${newStatus}`);
        } catch (error) {
            console.error("Failed to update invoice status:", error);
            notify.error("Could not update the invoice status");
        }
    }

    /** Resolves a selection to ids in SQL, so acting on a filtered set needs no loaded rows. */
    async function resolveSelectionIds(selection: InvoiceSelection): Promise<string[]> {
        return queryDatabase((repositories) =>
            repositories.invoices.querySelectionIds({
                direction: 'issued',
                today,
                scope: {
                    ids: selection.ids,
                    filters: selection.filters,
                    excludedIds: selection.excludedIds,
                },
            }),
        );
    }

    async function markInvoicesPaid(selection: InvoiceSelection): Promise<boolean> {
        try {
            const ids = await resolveSelectionIds(selection);
            if (!ids.length) return true;
            const invoices = await queryDatabase((repositories) => repositories.invoices.getInvoicesByIds(ids));
            const unpaid = invoices.filter((invoice) => invoice.status !== 'paid');
            if (!unpaid.length) return true;
            const events = unpaid.map((invoice) => {
                const supplier = resolvePartyForIssue(invoice, 'supplier');
                const customer = resolvePartyForIssue(invoice, 'customer');
                return {
                    id: crypto.randomUUID(),
                    type: 'INVOICE_UPDATED',
                    timestamp: Date.now(),
                    payload: {
                        id: invoice.id,
                        status: 'paid',
                        document_state: 'issued',
                        document_uuid: invoice.document_uuid || invoice.id,
                        ...supplier ? { supplier_snapshot: JSON.stringify(supplier) } : {},
                        ...customer ? { customer_snapshot: JSON.stringify(customer) } : {}
                    }
                };
            }) as ExtendedAppEvent[];
            await executeLocalCommand(events);
            await invalidate('app:invoices');
            notify.success(`${unpaid.length} invoice${unpaid.length === 1 ? '' : 's'} marked paid`);
            return true;
        } catch (error) {
            console.error('Failed to mark invoices paid:', error);
            notify.error('Could not mark the selected invoices paid');
            return false;
        }
    }

    function startEdit(invoice: Invoice) {
        isAddingInvoice = false;
        isImportingInvoice = false;
        cloningInvoice = null;
        editingInvoice = invoice;
    }

    function startClone(invoice: Invoice) {
        isAddingInvoice = false;
        isImportingInvoice = false;
        editingInvoice = null;
        cloningInvoice = invoice;
    }

    /** The list only knows a row, so the editor reads the whole record first. */
    async function startEditRow(row: InvoiceListRow): Promise<void> {
        const invoice = await loadInvoice(row.id);
        if (invoice) startEdit(invoice);
    }

    async function startCloneRow(row: InvoiceListRow): Promise<void> {
        const invoice = await loadInvoice(row.id);
        if (invoice) startClone(invoice);
    }

    async function requestRemoveMany(selection: InvoiceSelection): Promise<void> {
        const ids = await resolveSelectionIds(selection);
        if (!ids.length) return;
        const invoices = await queryDatabase((repositories) => repositories.invoices.getInvoicesByIds(ids));
        const numbers = invoices.map((invoice) => invoice.invoice_number);
        confirmTitle = ids.length === 1 ? 'Delete invoice?' : `Delete ${ids.length} invoices?`;
        confirmMessage = ids.length === 1
            ? `Remove invoice "${numbers[0] ?? ''}"?`
            : `Remove these ${ids.length} invoices: ${numbers.slice(0, 10).join(', ')}${numbers.length > 10 ? ', …' : ''}?`;
        confirmAction = async () => {
            const events = ids.map((id) => ({
                id: crypto.randomUUID(),
                type: 'INVOICE_REMOVED',
                timestamp: Date.now(),
                payload: { id },
            })) as ExtendedAppEvent[];
            await executeLocalCommand(events);
            await invalidate("app:invoices");
            if (selectedInvoiceId && ids.includes(selectedInvoiceId)) clearInvoiceSelection();
            await Promise.allSettled(invoices.map((invoice, index) => {
                const event = events[index];
                return event ? queueInvoicePdfDeletion(invoice, event.id) : Promise.resolve();
            }));
            notify.success(ids.length === 1 ? 'Invoice removed' : `${ids.length} invoices removed`);
        };
        showConfirmDialog = true;
    }

    function requestRemove(invoice: Invoice): void {
        void requestRemoveMany({
            ids: [invoice.id],
            filters: emptyInvoiceFilters(),
            excludedIds: [],
            rows: [],
            count: 1,
            pageRows: 1,
        });
    }

    function closeCommandUi(): void {
        isAddingInvoice = false;
        isImportingInvoice = false;
        editingInvoice = null;
        cloningInvoice = null;
        showConfirmDialog = false;
        confirmAction = null;
    }

    function closeInvoiceDrawer(): void {
        isAddingInvoice = false;
        isImportingInvoice = false;
        editingInvoice = null;
        cloningInvoice = null;
    }

    async function handleConfirm() {
        if (confirmAction) {
            await confirmAction();
        }
        showConfirmDialog = false;
        confirmAction = null;
    }

    function handleCancel() {
        showConfirmDialog = false;
        confirmAction = null;
    }

    $effect(() => {
        if (resource.loading) return;
        if (!browser) return;
        if (page.url.searchParams.get("newInvoice") !== "1") return;
        if (handledNewInvoiceUrl === page.url.href) return;

        if (!runCommandAction(() => isAddingInvoice = true)) return;
        handledNewInvoiceUrl = page.url.href;

        const nextUrl = new URL(page.url);
        nextUrl.searchParams.delete("newInvoice");
        const query = nextUrl.searchParams.toString();
        void goto(`${nextUrl.pathname}${query ? `?${query}` : ""}${nextUrl.hash}`, {
            reset: false,
            replace: true,
        });
    });


    // Phones keep an invoice's actions under its amount, so the sheet needs no footer.
    const phone = new MediaQuery('max-width: 767px');

    function startNewInvoice(): void {
        isImportingInvoice = false;
        isAddingInvoice = true;
    }

    function startImportInvoice(): void {
        isAddingInvoice = false;
        isImportingInvoice = true;
    }
</script>

<svelte:head><title>Invoices | stor</title></svelte:head>
<PageDataStatus resource={resource} />
<CommandOnly onUnavailable={closeCommandUi} />

<div class="stor-refined stor-page w-full p-2.5 sm:p-3">
    {#snippet invoiceTabs()}
        <Tabs.Root value={invoiceTab} onValueChange={(value) => selectInvoiceTab(value as 'issued' | 'received' | 'analytics' | 'parties')}>
            <Tabs.List class="stor-page-tabs stor-primary-tabs mobile-scroll flex max-w-full items-center overflow-x-auto" aria-label="Invoice sections" {@attach tabIndicator}>
                <Tabs.Trigger value="issued" class="stor-page-tab">Issued</Tabs.Trigger>
                <Tabs.Trigger value="received" class="stor-page-tab">Received</Tabs.Trigger>
                <Tabs.Trigger value="analytics" class="stor-page-tab">Analytics</Tabs.Trigger>
                <Tabs.Trigger value="parties" class="stor-page-tab">Parties</Tabs.Trigger>
            </Tabs.List>
        </Tabs.Root>
    {/snippet}
    <PageHeader
        title="Invoices"
        class="max-md:sr-only"
        sidebarTabs
        tabs={invoiceTabs}
    >
        <!-- Below lg these actions float at the thumb's corner instead of taking a row above the list. -->
        <CommandOnly>
            {#if invoiceTab === 'issued'}
                <Button class="hidden lg:inline-flex" aria-label="New invoice" data-stor-new shortcut="N" onclick={startNewInvoice}>
                    <IconPlus class="h-4 w-4" />
                    New invoice
                </Button>
                <Button class="hidden lg:inline-flex" variant="secondary" aria-label="Import invoice" onclick={startImportInvoice}>
                    <IconUpload class="h-4 w-4" />
                    Import invoice
                </Button>
            {:else if invoiceTab === 'received'}
                <Button class="hidden lg:inline-flex" aria-label="Upload invoice" onclick={() => uploadRequested++}>
                    <IconUpload class="h-4 w-4" /> Upload invoice
                </Button>
            {/if}
        </CommandOnly>
    </PageHeader>

    <!-- Both directions stay mounted: switching tabs only toggles visibility,
         so the list keeps its rows instead of flashing its loading state. -->

    <div
        class="flex flex-col gap-[var(--stor-section-gap)]"
        class:hidden={invoiceTab !== 'issued'}
    >
        <InvoiceOverview
            glance={invoiceTab === 'issued'}
            today={today}
            revision={resource.revision}
            loading={resource.loading}
        />

        <section
            class="stor-panel"
            style:overflow="visible"
            aria-label="Invoice list"
        >
            <InvoiceListPanel
                today={today}
                revision={resource.revision}
                loading={resource.loading}
                selectedId={selectedInvoiceId}
                onSelect={selectInvoice}
                onEdit={(row) => void startEditRow(row)}
                onClone={(row) => void startCloneRow(row)}
                onRemove={(row) => void requestRemoveMany({ ids: [row.id], filters: emptyInvoiceFilters(), excludedIds: [], rows: [row], count: 1, pageRows: 1 })}
                onViewPdf={showInvoicePdf}
                onMarkPaid={markInvoicesPaid}
                onDelete={(selection) => void requestRemoveMany(selection)}
                onCreate={() => isAddingInvoice = true}
                onImport={startImportInvoice}
            />
        </section>
    </div>

    <div class:hidden={invoiceTab !== 'received'}>
        <ReceivedInvoices
            parties={parties}
            today={today}
            revision={resource.revision}
            loading={resource.loading}
            uploadRequested={uploadRequested}
        />
    </div>

    {#if invoiceTab === 'analytics'}
        <InvoiceAnalytics revision={resource.revision} loading={resource.loading} />
    {:else if invoiceTab === 'parties'}
        <InvoiceParties
            parties={parties}
            revision={resource.revision}
            loading={resource.loading}
            onCreateParty={createParty}
            onUpdateParty={updateParty}
        />
    {/if}
</div>

{#if invoiceTab === 'issued'}
    <MobilePageAction>
        <!-- Phones import from the list options; tablets keep the icon beside the pill. -->
        <Button variant="secondary" class="!w-11 !px-0 max-md:hidden" aria-label="Import invoice" onclick={startImportInvoice}><IconUpload class="h-5 w-5" /></Button>
        <Button class="text-[15px]" aria-label="New invoice" onclick={startNewInvoice}><IconPlus class="h-5 w-5" /> <span class="stor-action-label">New invoice</span></Button>
    </MobilePageAction>
{:else if invoiceTab === 'received'}
    <MobilePageAction>
        <Button class="text-[15px]" aria-label="Upload invoice" onclick={() => uploadRequested++}><IconUpload class="h-5 w-5" /> <span class="stor-action-label">Upload invoice</span></Button>
    </MobilePageAction>
{/if}

{#snippet invoiceFooter()}
    {@const invoice = selectedInvoice}
    {#if invoice}
        <CommandOnly>
            {#if invoice.status === 'draft'}
                <Button variant="secondary" size="sm" onclick={() => handleUpdateStatus(invoice, 'sent')}>Mark sent</Button>
            {/if}
            {#if invoice.status !== 'paid'}
                <Button variant="secondary" size="sm" class="max-md:hidden" onclick={() => handleUpdateStatus(invoice, 'paid')}>Mark paid</Button>
            {/if}
        </CommandOnly>
        <InvoiceActionsMenu
            label={`invoice ${invoice.invoice_number}`}
            items={[
                { label: 'View details', onSelect: () => selectInvoiceView('details') },
                { label: 'View PDF', onSelect: () => selectInvoiceView('pdf') },
                { label: 'Edit invoice', commandOnly: true, onSelect: () => startEdit(invoice) },
                { label: 'Clone invoice', commandOnly: true, onSelect: () => startClone(invoice) },
                { label: 'Delete', tone: 'danger', commandOnly: true, onSelect: () => requestRemove(invoice) },
            ]}
        />
        <CommandOnly>
            <Button size="sm" onclick={() => startEdit(invoice)}>Edit invoice</Button>
        </CommandOnly>
    {/if}
{/snippet}
{#snippet invoiceMenu(invoice: Invoice)}
    <InvoiceActionsMenu
        label={`invoice ${invoice.invoice_number}`}
        items={[
            { label: 'Edit invoice', commandOnly: true, onSelect: () => startEdit(invoice) },
            ...(invoice.status === 'draft' ? [{ label: 'Mark sent', commandOnly: true, onSelect: () => void handleUpdateStatus(invoice, 'sent') }] : []),
            { label: 'Clone invoice', commandOnly: true, onSelect: () => startClone(invoice) },
            { label: 'Delete', tone: 'danger' as const, commandOnly: true, onSelect: () => requestRemove(invoice) },
        ]}
    />
{/snippet}

<Drawer
    show={invoiceTab === 'issued' && selectedInvoiceId !== null && !isAddingInvoice && !isImportingInvoice && !editingInvoice && !cloningInvoice}
    title={selectedInvoice ? `Invoice ${selectedInvoice.invoice_number}` : 'Invoice'}
    description={selectedInvoice
        ? resolveInvoiceParty(selectedInvoice, parties, 'customer')?.name ?? 'No customer'
        : ''}
    size="lg"
    onClose={clearInvoiceSelection}
    footer={phone.current ? undefined : invoiceFooter}
>
    {#if selectedInvoice}
        {@const invoice = selectedInvoice}
        <section role="region" aria-label={`Invoice ${invoice.invoice_number}`}>
            <Tabs.Root value={invoiceView} onValueChange={(value) => selectInvoiceView(value as 'details' | 'pdf')}>
                <Tabs.List class="stor-page-tabs mb-4 inline-grid grid-cols-2 {invoiceView === 'details' ? 'max-md:hidden' : ''}" aria-label="Invoice view" {@attach tabIndicator}>
                    <Tabs.Trigger value="details" class="stor-page-tab">Details</Tabs.Trigger>
                    <Tabs.Trigger value="pdf" class="stor-page-tab">PDF</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="details"><InvoiceDetailPanel invoice={invoice} parties={parties} onMarkPaid={() => handleUpdateStatus(invoice, 'paid')} onShowPdf={() => selectInvoiceView('pdf')} menu={invoiceMenu} /></Tabs.Content>

                <Tabs.Content value="pdf">
                    <div class="flex h-[65dvh] min-h-[20rem] flex-col overflow-hidden rounded-xl">
                        <InvoicePdfViewer
                            invoice={invoice}
                            parties={parties}
                            isOverdue={isInvoiceOverdue(invoice, today)}
                            active={invoiceView === 'pdf'}
                        />
                    </div>
                </Tabs.Content>
            </Tabs.Root>
        </section>
    {:else}
        <p class="text-sm text-[var(--stor-muted-text)]">Loading invoice…</p>
    {/if}
</Drawer>

<InvoiceDrawer
    show={isAddingInvoice || isImportingInvoice || !!editingInvoice || !!cloningInvoice}
    importMode={isImportingInvoice}
    invoice={editingInvoice}
    cloneFrom={cloningInvoice}
    parties={parties}
    onClose={closeInvoiceDrawer}
    onSave={saveInvoice}
    onCreateParty={createParty}
    onUpdateParty={updateParty}
/>

<CommandConfirmDialog
    show={showConfirmDialog}
    title={confirmTitle}
    message={confirmMessage}
    onConfirm={handleConfirm}
    onCancel={handleCancel}
/>

<CommandConfirmDialog
    show={duplicatePrompt !== null}
    title="Possible duplicate invoice"
    message={duplicatePrompt ? duplicatePromptMessage(duplicatePrompt.matches, 'customer') : ''}
    confirmLabel={editingInvoice ? 'Save anyway' : isImportingInvoice ? 'Import anyway' : 'Save anyway'}
    tone="primary"
    onConfirm={() => resolveDuplicate(true)}
    onCancel={() => resolveDuplicate(false)}
/>

<CommandConfirmDialog
    show={partyMatchPrompt !== null}
    title="Possible duplicate party"
    message={partyMatchPrompt ? partyMatchMessage(partyMatchPrompt.match) : ''}
    confirmLabel="Use existing"
    alternateLabel="Create anyway"
    tone="primary"
    onConfirm={() => resolvePartyMatch('existing')}
    onAlternate={() => resolvePartyMatch('create')}
    onCancel={() => resolvePartyMatch('cancel')}
/>
