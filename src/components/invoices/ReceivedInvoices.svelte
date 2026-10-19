<script lang="ts">
    import IconFileUpload from '~icons/mdi/file-upload-outline';
    import { Tabs } from 'bits-ui';
    import { Drawer } from "@hearthlog/sdk/ui";
    import { Button } from "@hearthlog/sdk/ui";
    import InvoiceBatchTable from './InvoiceBatchTable.svelte';
    import InvoiceActionsMenu from './InvoiceActionsMenu.svelte';
    import type { InvoiceListRow, InvoiceSelection } from '../../invoices/list-contracts.js';
    import type { ExtendedAppEvent } from '@hearthlog/sdk/data';
    import { CommandOnly } from "@hearthlog/sdk/ui";
    import { CommandConfirmDialog } from "@hearthlog/sdk/ui";
    import ReceivedInvoicePdfViewer from './ReceivedInvoicePdfViewer.svelte';
    import { SyncStateBadge } from '@hearthlog/sdk/ui';
    import { SuggestButton } from '@hearthlog/sdk/ui';
    import { ChoiceChips } from "@hearthlog/sdk/ui";
    import { FoldLine } from "@hearthlog/sdk/ui";
    import IconFilePdf from '~icons/mdi/file-pdf-box';
    import { SuggestionChip } from '@hearthlog/sdk/ui';
    import { isAiCapabilityEnabled } from '@hearthlog/sdk/runtime';
    import { SuggestionMark } from '@hearthlog/sdk/ui';
    import TypeInvoicesSheet, { type ExpenseTypeChange } from './TypeInvoicesSheet.svelte';
    import { format, parseISO } from 'date-fns';
    import { EXPENSE_TYPES, expenseTypeLabel } from '../../invoices/expense-types.js';
    import { expenseTypeHistoryReason, suggestExpenseTypesDetailed, type ExpenseTypeSuggestion } from '../../invoices/expense-type-suggestions.js';
    import { tabIndicator } from '@hearthlog/sdk/ui';
    import InvoiceDetailCard from './InvoiceDetailCard.svelte';
    import InvoiceDetailLineItems from './InvoiceDetailLineItems.svelte';
    import InvoiceDetailSummary from './InvoiceDetailSummary.svelte';
    import InvoiceIsdocCard from './InvoiceIsdocCard.svelte';
    import InvoiceStatusBadge from './InvoiceStatusBadge.svelte';
    import type { ReceivedInvoice } from '../../data/invoices.js';
    import { queryDatabase } from '@hearthlog/sdk/data';
    import { parseExtractionMetadata, receivedBreakdown, receivedLineNet } from '../../invoices/received-document.js';
    import { executeLocalCommand } from '@hearthlog/sdk/data';
    import { refreshPageData } from '@hearthlog/sdk/runtime';
    import { notify } from '@hearthlog/sdk/runtime';
    import { formatFileSize } from '../../invoices/format.js';
    import { invoiceRouteState, navigateInvoices } from '../../invoices/url.js';
    import { invoiceStatusOf } from '../../invoices/status.js';
    import {
        queueReceivedPdf, queueReceivedIsdoc,
        discardQueuedReceivedFile, retryReceivedPdf, getReceivedIsdoc,
        runReceivedFileUploads, validateReceivedPdf,
    } from '../../invoices/received-file-store.js';
    import { invoiceStorageLabel } from '../../invoices/invoice-file-store.js';
    import { activeParties, type InvoicePartySource } from '../../invoices/document.js';
    import { matchImportParty } from '../../invoices/import.js';
    import {
        duplicatePromptMessage,
        findDuplicates,
        normalizeInvoiceNumber,
        receivedDuplicateCandidate,
        type DuplicateInvoice,
    } from '../../invoices/duplicates.js';
    import { readIsdocFromPdf } from '../../invoices/extraction/pdf-extract.js';
    import { readIsdocFile } from '../../invoices/extraction/isdoc.js';
    import { readInvoiceWithAi } from '../../invoices/extraction/ai.js';
    import {
        formValuesFrom, mergeExtraction, serializeExtractionMetadata, serializeItems,
        type FormValues,
    } from '../../invoices/extraction/merge.js';
    import { parseDecimalString } from '../../invoices/extraction/decimal.js';
    import type { ExtractionResult, ExtractionWarning } from '../../invoices/extraction/types.js';
    import { commandActionsAvailable } from '@hearthlog/sdk/runtime';

    type Filter = 'review' | 'unpaid' | 'paid' | 'overdue';

    let {
        parties = [],
        today,
        revision = 0,
        loading = false,
        uploadRequested = 0,
    }: {
        /** The unified party directory; merged aliases resolve, pickers hide them. */
        parties?: InvoicePartySource[];
        /** Local calendar date (YYYY-MM-DD) shared with the SQL list projection. */
        today: string;
        revision?: number;
        loading?: boolean;
        uploadRequested?: number;
    } = $props();

    let drawerOpen = $state(false);
    let editing = $state<ReceivedInvoice | null>(null);
    let file = $state<File | null>(null);
    let supplierName = $state('');
    let invoiceNumber = $state('');
    let amount = $state('');
    let issueDate = $state('');
    let dueDate = $state('');
    let description = $state('');
    // An expense type is suggested while it is empty and untouched; a suggestion only
    // fills the field, and choosing a type yourself removes the tag.
    let expenseType = $state('');
    // Phones: the file first, supplier and amount open, the number and dates as one line.
    let detailsOpen = $state(false);
    let allTypes = $state(false);
    let notesOpen = $state(false);
    let expenseTouched = $state(false);
    let appliedExpense = $state<ExpenseTypeSuggestion | null>(null);
    let offeredExpense = $state<ExpenseTypeSuggestion | null>(null);
    let expenseRun = 0;
    let expenseAsked = '';
    let expenseState = $state<'idle' | 'busy' | 'none' | 'unavailable'>('idle');
    const expenseAiEnabled = isAiCapabilityEnabled('invoice-expense-type');
    let saving = $state(false);
    let formError = $state('');
    let handledUploadRequest = 0;
    let pendingRemoval = $state<{ ids: string[]; label: string; count: number } | null>(null);
    // --- Extraction state (ISDOC first; the LLM path reuses the same shape) ---
    let extraction = $state<{ result: ExtractionResult; xml: string | null } | null>(null);
    let lastApplied = $state<FormValues | null>(null);
    let extractionStatus = $state<'idle' | 'reading' | 'found' | 'none' | 'unreadable'>('idle');
    let extractionNotice = $state('');
    let extractionRun = 0;
    // AI reading runs only on an explicit click; a 503 hides it for the session.
    let aiBusy = $state(false);
    let aiDisabled = $state(false);
    let aiFound = $state(false);
    let aiNotice = $state('');
    let aiProvider = $state('');
    let aiModel = $state('');
    let aiWarnings = $state<ExtractionWarning[]>([]);
    // A standalone ISDOC file chosen when the PDF carries none.
    let isdocFileBusy = $state(false);
    let isdocFileError = $state('');
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

    /**
     * Existing received invoices that share this save's number; the
     * counterparty is narrowed in memory because stored names and IČOs are
     * free-form and the normalized number is only the coarse lookup. Merged
     * directory aliases resolve to their survivor before the comparison.
     */
    async function findReceivedDuplicates(
        matchedSupplier: InvoicePartySource | undefined,
    ): Promise<DuplicateInvoice[]> {
        const number = normalizeInvoiceNumber(invoiceNumber);
        if (!number) return [];
        const rows = await queryDatabase((repositories) =>
            repositories.invoices.findReceivedInvoicesByNumber(number),
        );
        return findDuplicates(
            {
                id: editing?.id ?? null,
                invoiceNumber: number,
                partyName: supplierName.trim() || matchedSupplier?.name,
                partyIco:
                    extraction?.result.invoice.supplierIco ||
                    editing?.supplier_ico ||
                    matchedSupplier?.ico,
            },
            rows.map(receivedDuplicateCandidate),
        );
    }

    // --- Selection & view state (kept in the URL) ---
    // The panel stays mounted behind the other tabs, so only the visible
    // direction may follow the URL's selection; otherwise an issued invoice id
    // would open the received drawer too.
    const isActive = $derived(invoiceRouteState().tab === 'received');
    const selectedId = $derived(isActive ? invoiceRouteState().invoice : null);
    const activeView = $derived(invoiceRouteState().view);
    // The list only carries a projection, so the drawer reads the whole record.
    let selectedInvoice = $state<ReceivedInvoice | null>(null);

    $effect(() => {
        const id = selectedId;
        void revision;
        if (!id) {
            selectedInvoice = null;
            return;
        }
        let cancelled = false;
        queryDatabase((repositories) => repositories.invoices.getReceivedInvoice(id))
            .then((invoice) => { if (!cancelled) selectedInvoice = invoice; })
            .catch(() => { if (!cancelled) selectedInvoice = null; });
        return () => { cancelled = true; };
    });

    function selectInvoice(
        row: InvoiceListRow,
        options: { view?: 'details' | 'pdf'; history?: 'push' | 'replace' } = {},
    ): void {
        const history = options.history ?? (selectedId === null ? 'push' : 'replace');
        navigateInvoices({ invoice: row.id, view: options.view ?? 'details' }, history);
    }

    function selectView(view: 'details' | 'pdf'): void {
        if (!selectedId) return;
        navigateInvoices({ view });
    }

    function clearSelection(): void {
        navigateInvoices({ invoice: null, view: 'details' });
    }

    $effect(() => {
        if (uploadRequested === handledUploadRequest) return;
        // The page resets the counter on a tab switch; follow it so a later
        // request still opens the drawer while this panel stays mounted.
        const requested = uploadRequested > handledUploadRequest;
        handledUploadRequest = uploadRequested;
        if (requested) openCreate();
    });

    // A kept-alive panel must not hold its form drawer over another tab.
    $effect(() => {
        if (!isActive) drawerOpen = false;
    });
    $effect(() => {
        if (!drawerOpen) expenseRun += 1;
    });
    // Ask a moment after typing stops. Blur and a finished import ask at once; the same inputs are never asked twice.
    $effect(() => {
        void description;
        if (!drawerOpen || supplierName.trim().length < 3) return;
        const timer = setTimeout(() => void suggestExpense(), 700);
        return () => clearTimeout(timer);
    });
    $effect(() => {
        if (!isActive) typeSheetOpen = false;
    });

    function displayStatus(invoice: ReceivedInvoice): Filter {
        return invoiceStatusOf(invoice, today) as Filter;
    }
    function storageLabel(status: string): string {
        switch (status) {
            case 'uploaded': return 'Uploaded';
            case 'failed': return 'Upload failed';
            case 'missing': return 'File unavailable';
            default: return 'Saved on this device';
        }
    }

    const typeChips = $derived.by(() => {
        const chips: Array<{ value: string; label: string }> = EXPENSE_TYPES.slice(0, 3).map((type) => ({ value: type.value, label: type.label }));
        if (expenseType && !chips.some((chip) => chip.value === expenseType)) chips.unshift({ value: expenseType, label: expenseTypeLabel(expenseType) });
        return chips;
    });
    const shortDate = (value: string) => value ? format(parseISO(value), 'd MMM') : '—';
    const detailsSummary = $derived(`No. ${invoiceNumber || '—'} · issued ${shortDate(issueDate)} · due ${shortDate(dueDate)}`);
    $effect(() => {
        if (!drawerOpen) { detailsOpen = false; allTypes = false; notesOpen = false; }
    });

    function resetExpenseSuggestion(): void {
        expenseRun += 1;
        expenseTouched = false;
        appliedExpense = null;
        offeredExpense = null;
        expenseAsked = '';
        expenseState = 'idle';
    }

    function applyExpenseSuggestion(suggestion: ExpenseTypeSuggestion): void {
        expenseType = suggestion.expenseType;
        appliedExpense = suggestion;
        offeredExpense = null;
    }

    function chooseExpenseType(value: string): void {
        expenseRun += 1;
        expenseState = 'idle';
        expenseTouched = true;
        appliedExpense = null;
        offeredExpense = null;
        expenseType = value;
    }

    /** Line item descriptions the model reads: the fresh extraction, else the stored lines. */
    function currentLines(): string[] {
        if (extraction) return extraction.result.invoice.items.map((item) => item.description);
        try {
            const stored: unknown = JSON.parse(editing?.items ?? '[]');
            return Array.isArray(stored)
                ? stored.map((item) => (item as { description?: unknown })?.description).filter((value): value is string => typeof value === 'string')
                : [];
        } catch {
            return [];
        }
    }

    /** Asks for a suggestion. The automatic ask (`manual` false) is quiet; the button explains its result. */
    async function suggestExpense(manual = false): Promise<void> {
        const supplier = supplierName.trim();
        if (!drawerOpen || !supplier) return;
        const unsettled = !expenseTouched && expenseType === '';
        if (!manual && !unsettled) return;
        const lines = currentLines();
        const key = `${supplier}|${description.trim()}|${lines.join('|')}`;
        if (!manual && key === expenseAsked) return;
        expenseAsked = key;
        const run = ++expenseRun;
        if (manual) {
            expenseState = 'busy';
            appliedExpense = null;
            offeredExpense = null;
        }
        const result = await suggestExpenseTypesDetailed([{
            id: 'draft',
            supplierName: supplier,
            supplierIco: extraction?.result.invoice.supplierIco || editing?.supplier_ico || '',
            description,
            lines,
        }]).catch(() => null);
        // An answer that arrives after the user chose a type or closed the drawer is dropped.
        if (run !== expenseRun || !drawerOpen) return;
        if (!manual && (expenseTouched || expenseType !== '')) return;
        const found = result?.suggestions.get('draft');
        if (manual) expenseState = found ? 'idle' : !result || result.aiUnavailable ? 'unavailable' : 'none';
        if (!found) return;
        if (found.origin.kind === 'ai' && found.origin.band === 'offer') offeredExpense = found;
        else applyExpenseSuggestion(found);
    }

    function resetExtraction(): void {
        extractionRun += 1;
        extraction = null;
        lastApplied = null;
        extractionStatus = 'idle';
        extractionNotice = '';
        aiBusy = false;
        aiFound = false;
        aiNotice = '';
        aiProvider = '';
        aiModel = '';
        aiWarnings = [];
        isdocFileBusy = false;
        isdocFileError = '';
    }

    /**
     * Applies an extraction through the shared merge rules: empty and
     * untouched fields are filled, user edits are preserved and reported.
     * An ISDOC XML found earlier is kept when a later AI read refines fields.
     */
    function applyExtraction(result: ExtractionResult, xml: string | null): void {
        const incoming = formValuesFrom(result.invoice);
        const merged = mergeExtraction(
            { supplierName, invoiceNumber, amount, issueDate, dueDate },
            lastApplied,
            incoming,
        );
        supplierName = merged.values.supplierName;
        invoiceNumber = merged.values.invoiceNumber;
        amount = merged.values.amount;
        issueDate = merged.values.issueDate;
        dueDate = merged.values.dueDate;
        lastApplied = incoming;
        extraction = { result, xml: xml ?? extraction?.xml ?? null };
        extractionNotice = merged.preserved.length
            ? `Kept your edits for: ${merged.preserved.join(', ')}.`
            : '';
        void suggestExpense();
    }

    async function handleFileChange(selected: File | null): Promise<void> {
        file = selected;
        resetExtraction();
        if (!selected) return;
        const run = ++extractionRun;
        extractionStatus = 'reading';
        try {
            const outcome = await readIsdocFromPdf(selected);
            if (run !== extractionRun) return;
            if (outcome.kind === 'unreadable') {
                extractionStatus = 'unreadable';
                extractionNotice = outcome.message;
                return;
            }
            if (outcome.kind === 'none') {
                extractionStatus = 'none';
                return;
            }
            applyExtraction(outcome.result, outcome.xml);
            extractionStatus = 'found';
        } catch {
            if (run !== extractionRun) return;
            extractionStatus = 'none';
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
            applyExtraction({
                ...outcome.result,
                metadata: { ...outcome.result.metadata, origin: 'separate' },
            }, outcome.xml);
            extractionStatus = 'found';
        } catch {
            isdocFileError = 'The ISDOC file could not be read.';
        } finally {
            isdocFileBusy = false;
        }
    }

    /** Explicit AI read for PDFs without a usable ISDOC. */
    async function runAiExtraction(): Promise<void> {
        if (!file || aiBusy || aiDisabled) return;
        aiBusy = true;
        aiFound = false;
        aiNotice = '';
        aiWarnings = [];
        try {
            const outcome = await readInvoiceWithAi(file);
            if (outcome.kind === 'found') {
                applyExtraction({
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
                }, null);
                aiFound = true;
                aiProvider = outcome.provider;
                aiModel = outcome.model;
                aiWarnings = outcome.warnings;
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

    function openCreate() {
        editing = null;
        file = null;
        supplierName = '';
        invoiceNumber = '';
        amount = '';
        issueDate = '';
        dueDate = '';
        description = '';
        expenseType = '';
        formError = '';
        resetExtraction();
        resetExpenseSuggestion();
        drawerOpen = true;
    }
    function openEdit(invoice: ReceivedInvoice) {
        if (!commandActionsAvailable()) return;
        editing = invoice;
        file = null;
        supplierName = invoice.supplier_name;
        invoiceNumber = invoice.invoice_number;
        amount = invoice.amount > 0 ? String(invoice.amount) : '';
        issueDate = invoice.issue_date.slice(0, 10);
        dueDate = invoice.due_date.slice(0, 10);
        description = invoice.description;
        expenseType = invoice.expense_type ?? '';
        formError = '';
        resetExtraction();
        resetExpenseSuggestion();
        drawerOpen = true;
    }
    /** The list only knows an id; the editor needs the whole record. */
    async function openEditById(id: string): Promise<void> {
        if (!commandActionsAvailable()) return;
        const invoice = await queryDatabase((repositories) => repositories.invoices.getReceivedInvoice(id));
        if (invoice) openEdit(invoice);
    }
    function complete(): boolean {
        return Boolean(supplierName.trim() && invoiceNumber.trim() && String(amount).trim() &&
            parseAmount(amount) > 0 && issueDate && dueDate);
    }
    function parseAmount(value: string): number {
        const normalized = String(value).replace(/[\s\u00a0\u202f]/g, '');
        if (!/^\d+(?:[.,]\d{1,2})?$/.test(normalized)) return NaN;
        const parsed = Number(normalized.replace(',', '.'));
        return Number.isFinite(parsed) && parsed <= 1_000_000_000_000 ? parsed : NaN;
    }
    async function save() {
        if (saving) return;
        formError = '';
        if (!editing && !file) { formError = 'Choose a PDF to continue.'; return; }
        if (file) {
            try { await validateReceivedPdf(file); }
            catch (error) { formError = error instanceof Error ? error.message : 'Choose a valid PDF.'; return; }
        }
        if (String(amount).trim() && (!Number.isFinite(parseAmount(amount)) || parseAmount(amount) < 0)) {
            formError = 'Enter a valid amount.';
            return;
        }
        if (issueDate && dueDate && dueDate < issueDate) {
            formError = 'Due date must be on or after the issue date.';
            return;
        }
        const matchedSupplier = matchImportParty(activeParties(parties), {
            name: supplierName.trim(),
            ico: extraction?.result.invoice.supplierIco || editing?.supplier_ico || '',
        });
        const matches = await findReceivedDuplicates(matchedSupplier);
        if (matches.length && !(await promptDuplicate(matches))) return;
        saving = true;
        const id = editing?.id ?? crypto.randomUUID();
        const fileId = file ? crypto.randomUUID() : editing!.file_id;
        const extracted = extraction?.result.invoice ?? null;
        const isdocXml = extraction?.xml ?? null;
        const isdocFileId = isdocXml ? crypto.randomUUID() : editing?.isdoc_file_id ?? '';
        const attachmentName = typeof extraction?.result.metadata.attachmentName === 'string'
            ? extraction.result.metadata.attachmentName
            : '';
        const isdocName = isdocXml
            ? (attachmentName.endsWith('.isdoc') || attachmentName.endsWith('.xml')
                ? attachmentName
                : `${attachmentName || isdocFileId}.isdoc`)
            : editing?.isdoc_file_name ?? '';
        const isdocSize = isdocXml ? new TextEncoder().encode(isdocXml).byteLength : editing?.isdoc_size_bytes ?? 0;
        const queuedScopes: Array<Awaited<ReturnType<typeof queueReceivedPdf>>> = [];
        try {
            if (file) queuedScopes.push(await queueReceivedPdf(id, fileId, file));
            if (isdocXml) {
                queuedScopes.push(await queueReceivedIsdoc(
                    id, isdocFileId,
                    new File([isdocXml], isdocName, { type: 'application/xml;charset=utf-8' }),
                ));
            }
            const supplier = matchedSupplier;
            const status = complete() ? (editing?.status === 'paid' ? 'paid' : 'unpaid') : 'review';
            const fields = {
                supplierId: supplier?.id ?? '', supplierName: supplierName.trim(),
                supplierIco: extracted?.supplierIco || editing?.supplier_ico || '',
                supplierDic: extracted?.supplierDic || editing?.supplier_dic || '',
                invoiceNumber: invoiceNumber.trim(), amount: String(amount).trim() ? parseAmount(amount) : 0,
                subtotal: extracted ? parseDecimalString(extracted.subtotal) ?? 0 : editing?.subtotal ?? 0,
                vatTotal: extracted ? parseDecimalString(extracted.vatTotal) ?? 0 : editing?.vat_total ?? 0,
                vatApplicable: extracted ? extracted.vatApplicable : editing?.vat_applicable ?? null,
                items: extracted ? serializeItems(extracted.items) : editing?.items ?? '[]',
                taxPointDate: extracted?.taxPointDate || editing?.tax_point_date || '',
                currency: extracted?.currency || editing?.currency || 'CZK',
                issueDate, dueDate, description: description.trim(), status,
                paidAt: status === 'paid' ? editing?.paid_at ?? '' : '',
                bankAccount: extracted?.bankAccount || editing?.bank_account || '',
                variableSymbol: extracted?.variableSymbol || editing?.variable_symbol || '',
                fileId, fileName: file?.name ?? editing?.file_name ?? '',
                sizeBytes: file?.size ?? editing?.size_bytes ?? 0,
                storageStatus: file ? 'queued' : editing?.storage_status ?? 'queued',
                isdocFileId, isdocFileName: isdocName, isdocSizeBytes: isdocSize,
                isdocStorageStatus: isdocXml ? 'queued' : editing?.isdoc_storage_status ?? '',
                extractionSource: extraction ? extraction.result.source : editing?.extraction_source ?? '',
                extractionMetadata: extraction ? serializeExtractionMetadata(extraction.result) : editing?.extraction_metadata ?? '',
                expenseType,
            };
            await executeLocalCommand({
                id: crypto.randomUUID(),
                type: editing ? 'RECEIVED_INVOICE_UPDATED' : 'RECEIVED_INVOICE_ADDED',
                timestamp: Date.now(),
                payload: { id, ...fields },
            });
            await refreshPageData('app:invoices');
            drawerOpen = false;
            editing = null;
            file = null;
            resetExtraction();
            notify.success(status === 'review' ? 'Invoice saved for review' : 'Received invoice saved');
            void runReceivedFileUploads();
        } catch (error) {
            for (const scope of queuedScopes) await discardQueuedReceivedFile(scope);
            formError = error instanceof Error ? error.message : 'The invoice could not be saved.';
        } finally {
            saving = false;
        }
    }

    async function updateStatus(id: string, status: 'paid' | 'unpaid') {
        if (!commandActionsAvailable()) return;
        try {
            await executeLocalCommand({
                id: crypto.randomUUID(), type: 'RECEIVED_INVOICE_UPDATED', timestamp: Date.now(),
                payload: { id, status, paidAt: status === 'paid' ? new Date().toISOString() : '' },
            });
            await refreshPageData('app:invoices');
            notify.success(status === 'paid' ? 'Invoice marked paid' : 'Invoice marked unpaid');
        } catch (error) { console.error('Could not update received invoice', error); notify.error('Could not update the invoice.'); }
    }

    /** Resolves a selection to ids in SQL, so acting on a filtered set needs no loaded rows. */
    async function resolveSelectionIds(selection: InvoiceSelection): Promise<string[]> {
        return queryDatabase((repositories) =>
            repositories.invoices.querySelectionIds({
                direction: 'received',
                today,
                scope: {
                    ids: selection.ids,
                    filters: selection.filters,
                    excludedIds: selection.excludedIds,
                },
            }),
        );
    }

    async function removeMany(ids: string[]) {
        if (!ids.length) return;
        try {
            const events = ids.map((id) => ({
                id: crypto.randomUUID(), type: 'RECEIVED_INVOICE_REMOVED', timestamp: Date.now(),
                payload: { id },
            })) as ExtendedAppEvent[];
            await executeLocalCommand(events);
            await refreshPageData('app:invoices');
            if (selectedId && ids.includes(selectedId)) clearSelection();
            notify.success(ids.length === 1 ? 'Received invoice removed' : `${ids.length} received invoices removed`);
        } catch { notify.error('Could not remove the selected invoices.'); }
    }

    async function requestRemoval(selection: InvoiceSelection): Promise<void> {
        if (!commandActionsAvailable()) return;
        const ids = await resolveSelectionIds(selection);
        if (!ids.length) return;
        pendingRemoval = {
            ids,
            label: selection.rows.find((row) => ids.includes(row.id))?.invoiceNumber ?? 'this invoice',
            count: ids.length,
        };
    }

    async function markReceivedPaid(selection: InvoiceSelection): Promise<boolean> {
        if (!commandActionsAvailable()) return false;
        try {
            const ids = await resolveSelectionIds(selection);
            if (!ids.length) return true;
            const invoices = await queryDatabase((repositories) => repositories.invoices.getReceivedInvoicesByIds(ids));
            const unpaid = invoices.filter((invoice) => invoice.status !== 'paid');
            if (!unpaid.length) return true;
            const paidAt = new Date().toISOString();
            const events = unpaid.map((invoice) => ({
                id: crypto.randomUUID(), type: 'RECEIVED_INVOICE_UPDATED', timestamp: Date.now(),
                payload: { id: invoice.id, status: 'paid', paidAt },
            })) as ExtendedAppEvent[];
            await executeLocalCommand(events);
            await refreshPageData('app:invoices');
            notify.success(`${unpaid.length} invoice${unpaid.length === 1 ? '' : 's'} marked paid`);
            return true;
        } catch (error) {
            console.error('Could not mark received invoices paid', error);
            notify.error('Could not mark the selected invoices paid.');
            return false;
        }
    }

    // --- Type the backlog ---
    /** Received invoices without an expense type, counted in SQL. */
    let untyped = $state(0);
    let typeSheetOpen = $state(false);

    $effect(() => {
        void revision;
        let current = true;
        void queryDatabase((repositories) => repositories.invoices.countReceivedWithoutExpenseType())
            .then((count) => { if (current) untyped = count; })
            .catch(() => undefined);
        return () => { current = false; };
    });

    async function writeExpenseTypes(ids: string[], expenseTypeFor: (id: string) => string): Promise<void> {
        // One submission identity per action: retrying the same Apply stays idempotent.
        const submissionId = crypto.randomUUID();
        await executeLocalCommand(ids.map((id) => ({
            id: crypto.randomUUID(), type: 'RECEIVED_INVOICE_UPDATED', timestamp: Date.now(),
            payload: { id, expenseType: expenseTypeFor(id) },
        })) as ExtendedAppEvent[], { submissionId });
        await refreshPageData('app:invoices');
    }

    async function applyExpenseTypes(changes: ExpenseTypeChange[]): Promise<void> {
        const byId = new Map(changes.map((change) => [change.id, change.expenseType]));
        try {
            await writeExpenseTypes([...byId.keys()], (id) => byId.get(id) ?? '');
        } catch (error) {
            console.error('Could not type received invoices', error);
            throw error;
        }
        typeSheetOpen = false;
        notify.success(`${changes.length} invoice${changes.length === 1 ? '' : 's'} typed`, {
            label: 'Undo',
            run: () => undoExpenseTypes(changes.map((change) => change.id)).catch(() => undefined),
        });
    }

    /** Restores the empty type the sorted invoices had. */
    async function undoExpenseTypes(ids: string[]): Promise<void> {
        try {
            await writeExpenseTypes(ids, () => '');
            notify.success(`${ids.length} invoice${ids.length === 1 ? '' : 's'} restored`);
        } catch (error) {
            console.error('Could not undo typing', error);
            notify.error('Could not undo the typing.');
            throw error;
        }
    }

    async function retry(id: string) {
        if (!commandActionsAvailable()) return;
        try {
            const invoice = await queryDatabase((repositories) => repositories.invoices.getReceivedInvoice(id));
            if (!invoice) return;
            await retryReceivedPdf(invoice);
            notify.success('PDF upload retried');
        } catch (error) {
            notify.error(error instanceof Error ? error.message : 'Could not retry the upload.');
        }
    }
</script>

{#snippet statusBadge(row: InvoiceListRow)}
    <InvoiceStatusBadge status={row.status} />
{/snippet}

{#snippet typeInvoicesAction()}
    {#if untyped > 0}
        <CommandOnly>
            <Button variant="secondary" size="sm" onclick={() => typeSheetOpen = true}>Type {untyped} invoice{untyped === 1 ? '' : 's'}</Button>
        </CommandOnly>
    {/if}
{/snippet}

{#snippet actionsMenu(row: InvoiceListRow)}
    <InvoiceActionsMenu
        label={`received invoice ${row.invoiceNumber}`}
        items={[
            { label: 'View PDF', onSelect: () => selectInvoice(row, { view: 'pdf' }) },
            { label: 'Edit details', commandOnly: true, onSelect: () => void openEditById(row.id) },
            ...(row.status === 'review'
                ? []
                : [{ label: row.status === 'paid' ? 'Mark unpaid' : 'Mark paid', commandOnly: true, onSelect: () => void updateStatus(row.id, row.status === 'paid' ? 'unpaid' : 'paid') }]),
            ...(row.storageStatus === 'failed' || row.storageStatus === 'missing'
                ? [{ label: 'Retry upload', commandOnly: true, onSelect: () => void retry(row.id) }]
                : []),
            { label: 'Remove', tone: 'danger' as const, commandOnly: true, onSelect: () => void requestRemoval({ ids: [row.id], filters: invoiceRouteState().filters, excludedIds: [], rows: [row], count: 1, pageRows: 1 }) },
        ]}
    />
{/snippet}

{#snippet detailsPanel(invoice: ReceivedInvoice)}
    {@const breakdown = receivedBreakdown(invoice)}
    {@const sourceInfo = parseExtractionMetadata(invoice.extraction_metadata)}
    {@const status = displayStatus(invoice)}
    <div class="space-y-5">
        <div class="flex flex-wrap items-center gap-2">
            <InvoiceStatusBadge {status} />
            <SyncStateBadge entityId={`received_invoice:${invoice.id}`} />
        </div>

        <InvoiceDetailSummary
            total={breakdown.total}
            vatTotal={breakdown.vatTotal}
            issueDate={invoice.issue_date}
            dueDate={invoice.due_date}
            taxPointDate={invoice.tax_point_date}
        />

        <section class="grid gap-3 sm:grid-cols-2" aria-label="Supplier and payment">
            <InvoiceDetailCard
                label="Supplier"
                title={invoice.supplier_name || 'Supplier needed'}
                details={[
                    invoice.supplier_ico ? `IČO: ${invoice.supplier_ico}` : '',
                    invoice.supplier_dic ? `DIČ: ${invoice.supplier_dic}` : '',
                ].filter((line) => line.length > 0)}
            />
            <InvoiceDetailCard
                label="Payment"
                title={invoice.bank_account || 'Not set'}
                details={invoice.variable_symbol ? [`VS ${invoice.variable_symbol}`] : []}
            />
            <InvoiceDetailCard
                label="Expense type"
                title={expenseTypeLabel(invoice.expense_type) || 'Not set'}
            />
        </section>

        <InvoiceDetailLineItems
            items={breakdown.lines.map((line) => ({ ...line, net: receivedLineNet(line) }))}
            subtotal={breakdown.subtotal}
            total={breakdown.total}
            vatByRate={breakdown.groups.map((group): [number, number] => [group.rate, group.vat])}
        />

        {#if invoice.description}
            <section aria-label="Invoice notes">
                <h3 class="stor-panel-title border-b border-[var(--stor-border)] pb-2">Notes</h3>
                <p class="mt-1 whitespace-pre-wrap text-sm text-[var(--stor-muted-text)]">{invoice.description}</p>
            </section>
        {/if}

        <div class="space-y-3">
            <InvoiceDetailCard
                label="Original document"
                title={invoice.file_name || 'No file'}
                details={[`${formatFileSize(invoice.size_bytes)} · ${invoiceStorageLabel(invoice.storage_status)}`]}
            />
            {#if invoice.isdoc_file_id}
                <InvoiceIsdocCard
                    fileName={invoice.isdoc_file_name || 'invoice.isdoc'}
                    load={() => getReceivedIsdoc(invoice)}
                    sizeBytes={invoice.isdoc_size_bytes}
                    storageStatus={invoice.isdoc_storage_status}
                />
            {:else}
                <InvoiceIsdocCard message="No electronic invoice (ISDOC) is attached to this document." />
            {/if}
        </div>

        {#if sourceInfo}
            <section aria-label="Data source">
                <h3 class="stor-panel-title border-b border-[var(--stor-border)] pb-2">Data source</h3>
                <div class="mt-2 rounded-xl bg-[var(--stor-surface-muted)] p-3 text-sm text-[var(--stor-ink)]">
                    <p class="font-semibold">
                        {sourceInfo.source === 'isdoc' ? (sourceInfo.origin === 'separate' ? 'Uploaded ISDOC file' : 'Attached ISDOC') : sourceInfo.source === 'ai' ? `AI (${sourceInfo.provider || 'provider'}${sourceInfo.model ? ` ${sourceInfo.model}` : ''})` : 'Entered manually'}{#if sourceInfo.isdocVersion} · ISDOC {sourceInfo.isdocVersion}{/if}
                    </p>
                    {#if sourceInfo.warnings.some(warning => warning.message)}
                        <ul class="mt-1 list-disc space-y-0.5 pl-4 text-xs text-[var(--stor-accent-strong)]">
                            {#each sourceInfo.warnings.filter(warning => warning.message) as warning}
                                <li>{warning.message}</li>
                            {/each}
                        </ul>
                    {/if}
                </div>
            </section>
        {/if}
    </div>
{/snippet}

<section class="stor-panel" style:overflow="visible" aria-label="Received invoice list">
    <InvoiceBatchTable
        direction="received"
        {today}
        {revision}
        {loading}
        tableLabel="Received invoices"
        activeId={selectedId}
        partyLabel="Supplier"
        statusOptions={[
            { value: 'all', label: 'All statuses' },
            { value: 'review', label: 'To review' },
            { value: 'unpaid', label: 'Unpaid' },
            { value: 'paid', label: 'Paid' },
            { value: 'overdue', label: 'Overdue' },
        ]}
        emptyTitle="No received invoices yet"
        emptyDescription="Upload a supplier PDF to track its payment."
        storageLabel={storageLabel}
        statusBadge={statusBadge}
        actions={actionsMenu}
        onSelect={(row) => selectInvoice(row)}
        onMarkPaid={markReceivedPaid}
        onDelete={(selection) => void requestRemoval(selection)}
        onCreate={openCreate}
        createLabel="Upload invoice"
        showExpenseType
        toolbar={typeInvoicesAction}
    />
</section>

<Drawer
    show={selectedId !== null && !drawerOpen}
    title={selectedInvoice ? `Received invoice ${selectedInvoice.invoice_number || selectedInvoice.file_name}` : 'Received invoice'}
    description={selectedInvoice?.supplier_name || ''}
    size="lg"
    onClose={clearSelection}
>
    {#if selectedInvoice}
        <section role="region" aria-label={`Received invoice ${selectedInvoice.invoice_number || selectedInvoice.file_name}`}>
            <Tabs.Root value={activeView} onValueChange={(value) => selectView(value as 'details' | 'pdf')}>
                <Tabs.List class="stor-page-tabs mb-4 inline-grid grid-cols-2" aria-label="Received invoice view" {@attach tabIndicator}>
                    <Tabs.Trigger value="details" class="stor-page-tab">Details</Tabs.Trigger>
                    <Tabs.Trigger value="pdf" class="stor-page-tab">PDF</Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="details">{@render detailsPanel(selectedInvoice)}</Tabs.Content>
                <Tabs.Content value="pdf">
                    <div class="flex h-[65dvh] min-h-[20rem] flex-col overflow-hidden rounded-xl">
                        <ReceivedInvoicePdfViewer invoice={selectedInvoice} active={activeView === 'pdf'} />
                    </div>
                </Tabs.Content>
            </Tabs.Root>
        </section>
    {:else}
        <p class="text-sm text-[var(--stor-muted-text)]">Loading received invoice…</p>
    {/if}
    {#snippet footer()}
        {@const invoice = selectedInvoice}
        {#if invoice}
            <CommandOnly>
                {#if invoice.status !== 'review'}
                    <Button variant="secondary" size="sm" onclick={() => void updateStatus(invoice.id, invoice.status === 'paid' ? 'unpaid' : 'paid')}>
                        Mark {invoice.status === 'paid' ? 'unpaid' : 'paid'}
                    </Button>
                {/if}
            </CommandOnly>
            {#if invoice.storage_status === 'failed' || invoice.storage_status === 'missing'}
                <CommandOnly>
                    <Button variant="secondary" size="sm" onclick={() => void retry(invoice.id)}>Retry upload</Button>
                </CommandOnly>
            {/if}
            <CommandOnly>
                <Button variant="secondary" size="sm" onclick={() => void requestRemoval({ ids: [invoice.id], filters: invoiceRouteState().filters, excludedIds: [], rows: [], count: 1, pageRows: 1 })}>Remove invoice</Button>
            </CommandOnly>
            <CommandOnly><Button size="sm" onclick={() => openEdit(invoice)}>Edit details</Button></CommandOnly>
        {/if}
    {/snippet}
</Drawer>

<Drawer show={drawerOpen} title={editing ? 'Edit received invoice' : 'Upload received invoice'} size="lg" onClose={() => drawerOpen = false}>
    <form id="received-invoice-form" class="space-y-4" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <!-- The file as one card; tapping it opens the picker. -->
        <label class="flex min-h-16 cursor-pointer items-center gap-3 rounded-xl bg-[var(--stor-surface-muted)] px-3 py-2.5">
            <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--stor-negative-soft)] text-[var(--stor-negative)]"><IconFilePdf class="h-6 w-6" /></span>
            <span class="min-w-0 flex-1">
                <span class="block truncate text-[15px] font-semibold text-[var(--stor-ink)]">{file?.name ?? (editing ? editing.file_name : 'Choose the PDF')}</span>
                <span class="block text-xs {extractionStatus === 'found' || aiFound ? 'text-[var(--stor-positive)]' : 'text-[var(--stor-muted-text)]'}">{extractionStatus === 'reading' ? 'Reading…' : extractionStatus === 'found' || aiFound ? 'Read from the PDF; check the values' : file || editing ? 'PDF kept with the invoice' : 'PDF, up to 25 MiB'}</span>
            </span>
            <span class="shrink-0 text-sm font-semibold text-[var(--stor-accent-text)]">{file || editing ? 'Replace' : 'Choose'}</span>
            <input type="file" accept="application/pdf,.pdf" class="sr-only" onchange={(event) => { void handleFileChange(event.currentTarget.files?.[0] ?? null); }} />
        </label>
        {#if file && extraction?.xml == null && extractionStatus !== 'reading'}
            <div class="rounded-xl border border-[var(--stor-border)] bg-[var(--stor-surface-muted)] p-3 text-sm" role="status">
                <p class="font-semibold text-[var(--stor-ink)]">{extractionStatus === 'unreadable' ? 'The PDF could not be read' : 'No attached ISDOC found'}</p>
                <p class="mt-1 text-xs text-[var(--stor-muted-text)]">
                    {extractionStatus === 'unreadable' ? `${extractionNotice} ` : ''}Choose how to fill the invoice; the fields stay editable.
                </p>
                <div class="mt-2 flex flex-wrap items-center gap-2">
                    <label class="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--stor-border)] bg-[var(--stor-surface)] px-3 text-xs font-semibold text-[var(--stor-ink)] transition hover:bg-[var(--stor-surface-muted)] {isdocFileBusy ? 'pointer-events-none opacity-60' : ''}">
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
                        <Button size="sm" variant="secondary" onclick={() => void runAiExtraction()} disabled={aiBusy}>
                            {aiBusy ? 'Reading…' : aiFound ? 'Read again' : 'Read with AI'}
                        </Button>
                    {/if}
                    <span class="text-xs text-[var(--stor-muted-text)]">or enter the details below manually</span>
                </div>
                {#if isdocFileError}<p role="alert" class="mt-2 text-xs text-[var(--stor-accent-strong)]">{isdocFileError}</p>{/if}
                {#if aiFound}
                    <p class="mt-2 text-xs text-[var(--stor-positive)]">Filled by AI ({aiProvider}{aiModel ? ` ${aiModel}` : ''}) — check the values.</p>
                    {#if extractionNotice}<p class="mt-1 text-xs text-[var(--stor-muted-text)]">{extractionNotice}</p>{/if}
                    {#if aiWarnings.length}
                        <ul class="mt-2 list-disc space-y-0.5 pl-4 text-xs text-[var(--stor-accent-strong)]">
                            {#each aiWarnings as warning}
                                <li>{warning.message}</li>
                            {/each}
                        </ul>
                    {/if}
                {:else if aiNotice}
                    <p class="mt-2 text-xs text-[var(--stor-accent-strong)]">{aiNotice}</p>
                {:else if aiDisabled}
                    <p class="mt-2 text-xs text-[var(--stor-muted-text)]">AI reading is not configured for this site.</p>
                {/if}
            </div>
        {/if}
        <div class="grid grid-cols-[minmax(0,1fr)_8.5rem] gap-2">
            <label class="text-sm"><span class="sr-only">Supplier</span><input list="received-invoice-suppliers" placeholder="Supplier" bind:value={supplierName} onblur={() => void suggestExpense()} class="stor-field-control h-11 w-full px-3 text-base" /></label>
            <label class="text-sm"><span class="sr-only">Amount</span><input type="text" inputmode="decimal" placeholder="Kč" bind:value={amount} class="stor-field-control h-11 w-full px-3 text-right text-base" /></label>
        </div>
        {#if detailsOpen || !invoiceNumber || !dueDate}
            <div class="grid gap-3">
                <label class="text-sm">Invoice number<input placeholder="From the supplier PDF" bind:value={invoiceNumber} class="stor-field-control mt-1 h-11 w-full px-3 text-base" /></label>
                <div class="grid grid-cols-2 gap-2">
                    <label class="text-sm">Issued<input type="date" bind:value={issueDate} class="stor-field-control mt-1 h-11 w-full px-3" /></label>
                    <label class="text-sm">Due<input type="date" bind:value={dueDate} class="stor-field-control mt-1 h-11 w-full px-3" /></label>
                </div>
            </div>
        {:else}
            <FoldLine bind:open={detailsOpen} summary={detailsSummary} />
        {/if}
        <datalist id="received-invoice-suppliers">{#each activeParties(parties) as party}<option value={party.name}>{party.ico ? `${party.name} · IČO ${party.ico}` : party.name}</option>{/each}</datalist>
        <div class="block text-sm">
            <div class="flex items-center justify-between gap-2">
                <span id="received-expense-type-label">Expense type (optional)</span>
                {#if expenseAiEnabled}
                    <SuggestButton label="Suggest an expense type" busy={expenseState === 'busy'} disabled={!supplierName.trim()} onclick={() => void suggestExpense(true)} />
                {/if}
            </div>
            <ChoiceChips class="mt-1.5" label="Expense type" options={allTypes ? EXPENSE_TYPES.map((type) => ({ value: type.value as string, label: type.label })) : typeChips} value={expenseType} onChange={chooseExpenseType} more={allTypes ? undefined : 'All'} onMore={() => (allTypes = true)} />
            <div class="mt-1.5 flex min-h-5 items-center" aria-live="polite">
                {#if appliedExpense}
                    <SuggestionMark
                        kind={appliedExpense.origin.kind}
                        reason={appliedExpense.origin.kind === 'history' ? expenseTypeHistoryReason(appliedExpense.origin.via) : ''}
                    />
                {:else if offeredExpense}
                    <SuggestionChip label={expenseTypeLabel(offeredExpense.expenseType)} onclick={() => { if (offeredExpense) { expenseTouched = true; applyExpenseSuggestion(offeredExpense); } }} />
                {:else if expenseState === 'none'}
                    <span class="text-[11px] leading-4 text-[var(--stor-muted-text)]">No suggestion for this supplier.</span>
                {:else if expenseState === 'unavailable'}
                    <span class="text-[11px] leading-4 text-[var(--stor-muted-text)]">Suggestions aren’t available right now.</span>
                {/if}
            </div>
        </div>
        {#if !notesOpen && !description}
            <FoldLine bind:open={notesOpen} tone="link" summary="Description" />
        {:else}
        <label class="block text-sm">Description (optional)<textarea rows="2" bind:value={description} onblur={() => void suggestExpense()} class="mt-1 w-full rounded-lg border border-[var(--stor-border)] bg-[var(--stor-surface)] px-3 py-2"></textarea></label>
        {/if}
                {#if formError}<p role="alert" class="text-sm text-[var(--stor-accent-strong)]">{formError}</p>{/if}
    </form>
    {#snippet footer()}<Button variant="secondary" onclick={() => drawerOpen = false}>Cancel</Button><Button type="submit" form="received-invoice-form" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : amount.trim() ? `Save · ${amount.trim()} Kč` : 'Save received invoice'}</Button>{/snippet}
</Drawer>

<TypeInvoicesSheet show={typeSheetOpen && isActive} onClose={() => typeSheetOpen = false} onApply={applyExpenseTypes} />

<CommandConfirmDialog show={pendingRemoval !== null} title={pendingRemoval?.count === 1 ? 'Remove received invoice?' : `Remove ${pendingRemoval?.count ?? 0} received invoices?`}
    message={pendingRemoval?.count === 1
        ? `Remove ${pendingRemoval?.label}? The original PDF is retained in the log.`
        : `Remove these ${pendingRemoval?.count ?? 0} received invoices? The original PDFs are retained in the log.`}
    onConfirm={async () => { const pending = pendingRemoval; pendingRemoval = null; if (pending) await removeMany(pending.ids); }}
    onCancel={() => pendingRemoval = null} />

<CommandConfirmDialog
    show={duplicatePrompt !== null}
    title="Possible duplicate invoice"
    message={duplicatePrompt ? duplicatePromptMessage(duplicatePrompt.matches, 'supplier') : ''}
    confirmLabel="Import anyway"
    tone="primary"
    onConfirm={() => resolveDuplicate(true)}
    onCancel={() => resolveDuplicate(false)}
/>
