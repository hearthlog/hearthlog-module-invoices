<script lang="ts">
    const drawerId = $props.id();
    const drawerFormId0 = drawerId + "-0";

    import { format } from "date-fns";
    import type { Invoice } from "../../data/invoices.js";
    import { CommandDrawer } from "@hearthlog/sdk/ui";
    import { Button } from "@hearthlog/sdk/ui";
    import { DatePicker } from "@hearthlog/sdk/ui";
    import { Field } from "@hearthlog/sdk/ui";
    import { Input } from "@hearthlog/sdk/ui";
    import { Select, type SelectOption } from "@hearthlog/sdk/ui";
    import { Textarea } from "@hearthlog/sdk/ui";
    import { DEFAULT_PAYMENT_TERM_DAYS, DEFAULT_VAT_RATE } from "../../config/invoice-defaults.js";
    import InvoicePartyForm, {
        type InvoicePartyDraft,
    } from "./InvoicePartyForm.svelte";
    import { parseBankAccount } from "../../api/invoice-renderer.js";
    import InvoicePartyFields from "./InvoicePartyFields.svelte";
    import InvoiceImportPanel, { type ImportedDocumentPayload } from "./InvoiceImportPanel.svelte";
    import { activeParties, invoiceDocumentState, invoiceDueDate, invoicePartyForm, invoicePartyFromForm, invoicePaymentTermDays, resolveDirectoryParty, resolveInvoiceParty, type InvoicePartyFormValues, type InvoicePartySource } from "../../invoices/document.js";
    import { importedLineItems, importedPaymentTermDays, importedVatApplicable, matchImportParty, mergeImportedFields, IMPORT_FIELD_LABELS, type ImportFieldSnapshot } from "../../invoices/import.js";
    import { serializeExtractionMetadata } from "../../invoices/extraction/merge.js";
    import type { ExtractedInvoice } from "../../invoices/extraction/types.js";
    import IconClose from "~icons/mdi/close";
    import IconPencil from "~icons/mdi/pencil-outline";
    import IconPlus from "~icons/mdi/plus";
    import { ChoiceChips } from "@hearthlog/sdk/ui";
    import { FoldLine } from "@hearthlog/sdk/ui";
    import { queryDatabase } from "@hearthlog/sdk/data";
    import { nextInvoiceNumber } from "../../invoices/number.js";

    export type InvoiceParty = InvoicePartySource;
    type PartySide = "supplier" | "customer";

    /** The source document of an imported invoice, kept with the record. */
    export interface InvoiceImportAttachment {
        file: File;
        isdocXml: string | null;
        /** Display name for the stored ISDOC XML, when the document carries one. */
        isdocName: string | null;
        source: string;
        metadata: string;
    }

    export interface InvoiceLineItemDraft {
        description: string;
        quantity: number;
        unitPrice: number;
        vatRate: number;
    }

    export interface InvoiceDraft {
        invoiceNumber: string;
        description: string;
        items: InvoiceLineItemDraft[];
        supplierId: string;
        customerId: string;
        issueDate: string;
        /** Whole days from the issue date; the due date is derived on save. */
        paymentTermDays: number;
        taxPointDate: string;
        documentState: "draft" | "issued";
        vatApplicable: "" | "true" | "false";
        supplierSnapshot: string | null;
        customerSnapshot: string | null;
        /** Present when the invoice is imported from an existing document. */
        import?: InvoiceImportAttachment | null;
    }

    let {
        show,
        invoice = null,
        cloneFrom = null,
        importMode = false,
        parties = [],
        onClose,
        onSave,
        onCreateParty,
        onUpdateParty,
    }: {
        show: boolean;
        invoice?: Invoice | null;
        cloneFrom?: Invoice | null;
        /** Imports an existing document instead of creating a new invoice. */
        importMode?: boolean;
        /** The unified directory; merged aliases resolve, pickers hide them. */
        parties?: InvoiceParty[];
        onClose: () => void;
        onSave: (draft: InvoiceDraft) => Promise<void>;
        onCreateParty?: (
            draft: InvoicePartyDraft,
        ) => Promise<{ id: string; name: string } | null>;
        onUpdateParty?: (
            draft: InvoicePartyDraft,
        ) => Promise<{ id: string; name: string } | null>;
    } = $props();

    function createEmptyItem(): InvoiceLineItemDraft {
        return {
            description: "",
            quantity: 1,
            unitPrice: 0,
            vatRate: DEFAULT_VAT_RATE,
        };
    }

    function parseItems(itemsJson: string | null): InvoiceLineItemDraft[] {
        if (!itemsJson) return [createEmptyItem()];
        try {
            const parsed = JSON.parse(itemsJson);
            return Array.isArray(parsed) && parsed.length > 0
                ? parsed
                : [createEmptyItem()];
        } catch {
            return [createEmptyItem()];
        }
    }

    /** Date input value for a stored timestamp, defaulting to today. */
    function formatIssueDate(value: string | null | undefined): string {
        if (!value) return format(new Date(), "yyyy-MM-dd");
        const date = new Date(value);
        return Number.isNaN(date.getTime())
            ? format(new Date(), "yyyy-MM-dd")
            : format(date, "yyyy-MM-dd");
    }

    /**
     * Tax point date (DUZP) input value: the stored date, the invoice's issue
     * date for records created before the field existed, or today.
     */
    function formatTaxPointDate(
        taxPointDate: string | null,
        issueDate: string | null | undefined,
    ): string {
        return formatIssueDate(taxPointDate || issueDate);
    }

    let form = $state<InvoiceDraft>({
        invoiceNumber: "",
        description: "",
        items: [createEmptyItem()],
        supplierId: "",
        customerId: "",
        issueDate: formatIssueDate(null),
        paymentTermDays: DEFAULT_PAYMENT_TERM_DAYS,
        taxPointDate: formatIssueDate(null),
        documentState: "draft",
        vatApplicable: "",
        supplierSnapshot: null,
        customerSnapshot: null,
    });
    let supplierDetails = $state(invoicePartyForm(undefined, "supplier"));
    let customerDetails = $state(invoicePartyForm(undefined, "customer"));
    let loadedSupplierKey = "";
    let loadedCustomerKey = "";
    let saving = $state(false);
    let errorMessage = $state("");
    let loadedKey = "";
    let partyEditor = $state<PartySide | null>(null);
    let editingParty = $state<{ side: PartySide; party: InvoicePartySource } | null>(
        null,
    );
    /**
     * New invoices default DUZP to the issue date; once the user edits DUZP
     * directly, later issue-date changes leave it alone.
     */
    let taxPointDateTouched = $state(false);

    // --- Document import state ---
    let importAttachment = $state<InvoiceImportAttachment | null>(null);
    let lastImportApplied = $state<ImportFieldSnapshot | null>(null);
    let suggestedSupplier = $state<InvoicePartyFormValues | null>(null);
    let suggestedCustomer = $state<InvoicePartyFormValues | null>(null);
    let importNotice = $state("");

    /** The issued-form values an extraction proposes, for merge comparisons. */
    function currentImportSnapshot(): ImportFieldSnapshot {
        return {
            invoiceNumber: form.invoiceNumber,
            issueDate: form.issueDate,
            taxPointDate: form.taxPointDate,
            paymentTermDays: Number(form.paymentTermDays),
            vatApplicable: form.vatApplicable,
            itemsJson: JSON.stringify(form.items),
            supplierId: form.supplierId,
            customerId: form.customerId,
        };
    }

    function partyFormFromExtraction(
        extracted: ExtractedInvoice,
        role: "supplier" | "customer",
    ): InvoicePartyFormValues {
        return invoicePartyForm(
            {
                id: "",
                name: role === "supplier" ? extracted.supplierName : extracted.customerName,
                street: role === "supplier" ? extracted.supplierStreet : extracted.customerStreet,
                city: role === "supplier" ? extracted.supplierCity : extracted.customerCity,
                ico: role === "supplier" ? extracted.supplierIco : extracted.customerIco,
                dic: role === "supplier" ? extracted.supplierDic : extracted.customerDic,
                bank_account: role === "supplier" ? extracted.bankAccount : null,
                registration: null,
                postal_address: null,
            },
            role,
        );
    }

    /**
     * Applies a reader result to the form. Fields the user already edited are
     * preserved; a party missing from the directory becomes a suggestion that
     * is created with the invoice on import.
     */
    function applyImport(payload: ImportedDocumentPayload): void {
        const { result } = payload;
        const extracted = result.invoice;
        const attachmentName = typeof result.metadata.attachmentName === "string" ? result.metadata.attachmentName : "";
        importAttachment = {
            file: payload.file,
            isdocXml: payload.xml,
            isdocName: payload.xml
                ? attachmentName.endsWith(".isdoc") || attachmentName.endsWith(".xml")
                    ? attachmentName
                    : `${attachmentName || "invoice"}.isdoc`
                : null,
            source: result.source,
            metadata: serializeExtractionMetadata(result),
        };

        const vatApplicable = importedVatApplicable(extracted);
        let items = importedLineItems(extracted);
        if (vatApplicable === "false") {
            items = items.map((item) => ({ ...item, vatRate: 0 }));
        }
        const supplierMatch = matchImportParty(parties, {
            name: extracted.supplierName,
            ico: extracted.supplierIco,
        });
        const customerMatch = matchImportParty(parties, {
            name: extracted.customerName,
            ico: extracted.customerIco,
        });
        const current = currentImportSnapshot();
        const incoming: ImportFieldSnapshot = {
            invoiceNumber: extracted.invoiceNumber,
            issueDate: extracted.issueDate,
            taxPointDate: extracted.taxPointDate || extracted.issueDate,
            paymentTermDays: importedPaymentTermDays(extracted) ?? current.paymentTermDays,
            vatApplicable,
            itemsJson: JSON.stringify(items),
            // A missing match leaves the current selection to the merge rules.
            supplierId: supplierMatch?.id ?? "",
            customerId: customerMatch?.id ?? "",
        };
        const merged = mergeImportedFields(current, lastImportApplied, incoming);
        form.invoiceNumber = merged.values.invoiceNumber;
        form.issueDate = merged.values.issueDate;
        form.taxPointDate = merged.values.taxPointDate;
        form.paymentTermDays = merged.values.paymentTermDays;
        form.vatApplicable = merged.values.vatApplicable as InvoiceDraft["vatApplicable"];
        form.items = parseItems(merged.values.itemsJson);
        form.supplierId = merged.values.supplierId;
        form.customerId = merged.values.customerId;
        form.documentState = "issued";
        lastImportApplied = merged.values;

        // A document whose party is not in the directory is offered for
        // creation on import, unless the field already holds a selection.
        suggestedSupplier = form.supplierId
            ? null
            : extracted.supplierName
              ? partyFormFromExtraction(extracted, "supplier")
              : suggestedSupplier;
        suggestedCustomer = form.customerId
            ? null
            : extracted.customerName
              ? partyFormFromExtraction(extracted, "customer")
              : suggestedCustomer;

        const notices: string[] = [];
        if (merged.preserved.length) {
            notices.push(
                `Kept your edits for: ${merged.preserved.map((key) => IMPORT_FIELD_LABELS[key]).join(", ")}.`,
            );
        }
        if (extracted.currency && extracted.currency.toUpperCase() !== "CZK") {
            notices.push(
                `The document is in ${extracted.currency}; amounts are recorded in CZK, convert them before importing.`,
            );
        }
        importNotice = notices.join(" ");
    }

    function handleImportFileSelected(selected: File | null): void {
        importAttachment = selected
            ? { file: selected, isdocXml: null, isdocName: null, source: "", metadata: "" }
            : null;
    }

    /**
     * Creates directory entries for extracted parties that are not yet known,
     * so importing a document from another system is a single action.
     */
    async function ensureImportedParties(): Promise<{
        supplier: InvoiceParty | null;
        customer: InvoiceParty | null;
    }> {
        let supplier: InvoiceParty | null = null;
        let customer: InvoiceParty | null = null;
        if (!onCreateParty) return { supplier, customer };
        if (!form.supplierId && suggestedSupplier) {
            const created = await onCreateParty({ ...suggestedSupplier });
            if (created) {
                form.supplierId = created.id;
                supplier = invoicePartyFromForm({
                    ...suggestedSupplier,
                    id: created.id,
                    name: created.name || suggestedSupplier.name,
                });
            }
            suggestedSupplier = null;
        }
        if (!form.customerId && suggestedCustomer) {
            const created = await onCreateParty({ ...suggestedCustomer });
            if (created) {
                form.customerId = created.id;
                customer = invoicePartyFromForm({
                    ...suggestedCustomer,
                    id: created.id,
                    name: created.name || suggestedCustomer.name,
                });
            }
            suggestedCustomer = null;
        }
        return { supplier, customer };
    }

    const totalAmount = $derived(
        form.items.reduce(
            (sum, item) => sum + Number(item.quantity) * Number(item.unitPrice),
            0,
        ),
    );
    const partyOptions = $derived(
        activeParties(parties).map((party) => ({
            value: party.id,
            label: party.ico ? `${party.name} (${party.ico})` : party.name,
        })),
    );
    const hasParties = $derived(partyOptions.length > 0);
    const supplierOptions = $derived<SelectOption[]>([
        { value: "", label: "Select supplier..." },
        ...partyOptions,
    ]);
    const customerOptions = $derived<SelectOption[]>([
        { value: "", label: "Select customer..." },
        ...partyOptions,
    ]);
    const dueDate = $derived(
        invoiceDueDate(form.issueDate, Number(form.paymentTermDays)),
    );
    const dueDateHint = $derived(
        dueDate
            ? `Due ${format(new Date(`${dueDate}T12:00:00`), "dd MMM yyyy")}.`
            : "Number of days from the issue date.",
    );

    function buildForm(source: Invoice | null | undefined): InvoiceDraft {
        return {
            invoiceNumber: source?.invoice_number ?? "",
            documentState: source ? invoiceDocumentState(source) : "draft",
            vatApplicable: source?.vat_applicable == null ? "" : source.vat_applicable ? "true" : "false",
            supplierSnapshot: source?.supplier_snapshot ?? null,
            customerSnapshot: source?.customer_snapshot ?? null,
            description: source?.description ?? "",
            items: parseItems(source?.items ?? null),
            supplierId: resolveDirectoryParty(parties, source?.supplier_id)?.id ?? source?.supplier_id ?? "",
            customerId: resolveDirectoryParty(parties, source?.customer_id)?.id ?? source?.customer_id ?? "",
            issueDate: formatIssueDate(source?.issue_date),
            paymentTermDays: invoicePaymentTermDays(
                source?.issue_date,
                source?.due_date,
            ),
            taxPointDate: formatTaxPointDate(
                source?.tax_point_date ?? null,
                source?.issue_date,
            ),
        };
    }

    /**
     * Cloning copies parties, items, and notes, but starts a fresh document:
     * the number gets a "-copy" suffix and the dates reset to the defaults of
     * a new invoice so the user only adjusts what changed.
     */
    function buildCloneForm(source: Invoice): InvoiceDraft {
        return {
            ...buildForm(source),
            invoiceNumber: `${source.invoice_number}-copy`,
            documentState: "draft",
            issueDate: formatIssueDate(null),
            paymentTermDays: DEFAULT_PAYMENT_TERM_DAYS,
            taxPointDate: formatTaxPointDate(null, null),
        };
    }

    $effect(() => {
        if (!show) {
            loadedKey = "";
            partyEditor = null;
            loadedSupplierKey = "";
            loadedCustomerKey = "";
            return;
        }
        const key = importMode
            ? `${show}:import`
            : cloneFrom && !invoice
              ? `${show}:clone:${cloneFrom.id}`
              : `${show}:${invoice?.id ?? "new"}`;
        if (key === loadedKey) return;
        loadedKey = key;
        form = importMode
            ? { ...buildForm(null), documentState: "issued" }
            : cloneFrom && !invoice
              ? buildCloneForm(cloneFrom)
              : buildForm(invoice);
        errorMessage = "";
        partyEditor = null;
        taxPointDateTouched = false;
        if (importMode) {
            importAttachment = null;
            suggestedSupplier = null;
            suggestedCustomer = null;
            importNotice = "";
            // The fresh form is the baseline an extraction may fill; anything
            // the user changes before reading a document is preserved.
            lastImportApplied = currentImportSnapshot();
        }
    });

    $effect(() => {
        if (!show) return;
        const key = `${loadedKey}:${form.supplierId}`;
        if (key === loadedSupplierKey) return;
        const source = invoice ?? cloneFrom;
        supplierDetails = invoicePartyForm(source && source.supplier_id === form.supplierId
            ? resolveInvoiceParty(source, parties, "supplier")
            : resolveDirectoryParty(parties, form.supplierId), "supplier");
        loadedSupplierKey = key;
    });
    $effect(() => {
        if (!show) return;
        const key = `${loadedKey}:${form.customerId}`;
        if (key === loadedCustomerKey) return;
        const source = invoice ?? cloneFrom;
        customerDetails = invoicePartyForm(source && source.customer_id === form.customerId
            ? resolveInvoiceParty(source, parties, "customer")
            : resolveDirectoryParty(parties, form.customerId), "customer");
        loadedCustomerKey = key;
    });

    function togglePartyEditor(type: PartySide) {
        editingParty = null;
        partyEditor = partyEditor === type ? null : type;
    }

    function togglePartyEdit(side: PartySide) {
        partyEditor = null;
        const selected =
            side === "supplier"
                ? resolveDirectoryParty(parties, form.supplierId)
                : resolveDirectoryParty(parties, form.customerId);
        if (!selected) return;
        editingParty =
            editingParty?.party.id === selected.id
                ? null
                : { side, party: selected };
    }

    async function saveCreatedParty(draft: InvoicePartyDraft) {
        if (!onCreateParty) return null;
        return onCreateParty(draft);
    }

    /** Edit keeps the invoice draft's own details in step with the record. */
    async function saveEditedParty(draft: InvoicePartyDraft) {
        if (!onUpdateParty) return null;
        const side = editingParty?.side;
        const saved = await onUpdateParty(draft);
        if (!saved) return null;
        if (side === "supplier") supplierDetails = invoicePartyForm(draft);
        if (side === "customer") customerDetails = invoicePartyForm(draft);
        return saved;
    }

    function attachCreatedParty(party: { id: string; name: string }) {
        if (partyEditor === "supplier") form.supplierId = party.id;
        else if (partyEditor === "customer") form.customerId = party.id;
        partyEditor = null;
    }

    function addItem() {
        // Phones start a new row from the last one's price and VAT; a second month of the same work is two taps.
        const last = form.items[form.items.length - 1];
        const next = createEmptyItem();
        form.items = [...form.items, phoneForm && last ? { ...next, unitPrice: last.unitPrice, vatRate: last.vatRate } : next];
    }

    // ---------------------------------------------------------------- phones
    // Who and what first; the number, state, VAT, supplier and dates are one line of defaults.
    // The phone form layout is the form layout at every width (docs/design-concepts/desktop-backport-2026-10-05).
    const phone = { current: true };
    const phoneForm = $derived(phone.current && !importMode);
    let defaultsOpen = $state(false);
    let customersOpen = $state(false);
    let notesOpen = $state(false);
    let recentCustomerIds = $state<string[]>([]);
    let defaultsKey = "";

    $effect(() => {
        if (!show || !phoneForm) return;
        const key = `${invoice?.id ?? cloneFrom?.id ?? "new"}`;
        if (key === defaultsKey) return;
        defaultsKey = key;
        defaultsOpen = !!invoice;
        customersOpen = false;
        notesOpen = !!form.description;
        void queryDatabase((repositories) => repositories.invoices.getNewInvoiceDefaults())
            .then((defaults) => {
                recentCustomerIds = defaults.recentCustomerIds;
                if (invoice || cloneFrom) return;
                // Plain rules, all visible in the defaults line: the next number, your last supplier.
                if (!form.invoiceNumber) form.invoiceNumber = nextInvoiceNumber(defaults.lastNumber);
                if (!form.supplierId && defaults.lastSupplierId) form.supplierId = defaults.lastSupplierId;
            })
            .catch(() => undefined);
    });
    $effect(() => { if (!show) defaultsKey = ""; });

    function chooseCustomer(id: string): void {
        form.customerId = id;
        if (invoice) return;
        // The customer's last payment term, when there is one.
        void queryDatabase((repositories) => repositories.invoices.getCustomerPaymentTerm(id))
            .then((term) => { if (term !== null && form.customerId === id) form.paymentTermDays = term; })
            .catch(() => undefined);
    }

    const partyName = (id: string) => activeParties(parties).find((party) => party.id === id)?.name ?? "";
    const customerChips = $derived.by(() => {
        const ids = [...recentCustomerIds];
        if (form.customerId && !ids.includes(form.customerId)) ids.unshift(form.customerId);
        return ids.filter((id) => partyName(id)).slice(0, 4).map((id) => ({ value: id, label: partyName(id) }));
    });
    const shortDay = (value: string) => value ? format(new Date(`${value}T12:00:00`), "d MMM") : "—";
    const defaultsSummary = $derived([
        form.invoiceNumber || "No number",
        form.documentState === "issued" ? "issued" : "draft",
        form.issueDate === formatIssueDate(null) ? "issued today" : `issued ${shortDay(form.issueDate)}`,
        dueDate ? `due ${shortDay(dueDate)} (${form.paymentTermDays} days)` : "",
        form.vatApplicable === "true" ? "with VAT" : form.vatApplicable === "false" ? "without VAT" : "",
        form.supplierId ? `from ${partyName(form.supplierId)}` : "no supplier",
    ].filter(Boolean).join(" · "));

    function removeItem(index: number) {
        if (form.items.length <= 1) return;
        form.items = form.items.filter((_, itemIndex) => itemIndex !== index);
    }

    async function submit(event: SubmitEvent) {
        event.preventDefault();
        if (saving) return;
        if (importMode && !importAttachment) {
            errorMessage = "Choose the invoice PDF to import.";
            return;
        }
        if (!form.invoiceNumber.trim()) {
            errorMessage = "Enter an invoice number.";
            return;
        }
        if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
            errorMessage = "Add at least one line item with a positive amount.";
            return;
        }
        if (!form.issueDate) {
            errorMessage = "Choose an issue date.";
            return;
        }
        const paymentTermDays = Number(form.paymentTermDays);
        if (!Number.isInteger(paymentTermDays) || paymentTermDays < 0) {
            errorMessage = "Enter the payment term as a whole number of days.";
            return;
        }
        if (!form.taxPointDate) {
            errorMessage = "Choose the tax point date (DUZP).";
            return;
        }

        saving = true;
        errorMessage = "";
        try {
            let supplier = form.supplierId ? invoicePartyFromForm(supplierDetails) : null;
            let customer = form.customerId ? invoicePartyFromForm(customerDetails) : null;
            if (importMode) {
                // Parties found in the document but missing from the directory
                // are created before the invoice references them.
                const created = await ensureImportedParties();
                supplier = created.supplier ?? supplier;
                customer = created.customer ?? customer;
            }
            if (form.documentState === "issued") {
                if (!supplier || !customer) {
                    throw new Error("Choose a supplier and customer before issuing the invoice.");
                }
                if (!form.vatApplicable) {
                    throw new Error("Choose the VAT applicability before issuing the invoice.");
                }
                // Imported documents keep their own original, so renderer-only
                // facts such as the postal address and bank account are not
                // required before they can be recorded.
                if (!importMode) {
                    if (!supplier.postal_address) {
                        throw new Error("Add the supplier's building number to the street and postal code to the city (e.g. Ukázková 12, 110 00 Praha 1) before issuing the invoice.");
                    }
                    if (!customer.postal_address) {
                        throw new Error("Add the customer's building number to the street and postal code to the city (e.g. Vzorová 34, 602 00 Brno) before issuing the invoice.");
                    }
                    if (!parseBankAccount(supplier.bank_account)) {
                        throw new Error("Enter the supplier's bank account (e.g. 123456789/0100) before issuing the invoice.");
                    }
                }
            }
            await onSave({
                ...form,
                import: importMode ? importAttachment : null,
                supplierSnapshot: supplier ? JSON.stringify(supplier) : null,
                customerSnapshot: customer ? JSON.stringify(customer) : null,
                invoiceNumber: form.invoiceNumber.trim(),
                description: form.description.trim(),
                paymentTermDays: Number(form.paymentTermDays),
                items: form.items.map((item) => ({
                    ...item,
                    quantity: Number(item.quantity),
                    unitPrice: Number(item.unitPrice),
                })),
            });
        } catch (error) {
            errorMessage =
                error instanceof Error
                    ? error.message
                    : "The invoice could not be saved.";
        } finally {
            saving = false;
        }
    }

    function formatAmount(amount: number): string {
        return new Intl.NumberFormat("cs-CZ", {
            style: "currency",
            currency: "CZK",
        }).format(amount);
    }
</script>

<CommandDrawer
    {show}
    size="lg"
    title={importMode
        ? "Import invoice"
        : invoice
          ? "Edit invoice"
          : cloneFrom
            ? "Clone invoice"
            : "Create invoice"}
    description={importMode
        ? "Read an existing document, review the details, then import it as an issued invoice."
        : invoice
          ? "Update invoice details and line items."
          : cloneFrom
            ? "Review the copied details, then create the new invoice."
            : "Add billing details, parties, and line items."}
    {onClose}
>
    <form id={drawerFormId0} class="flex flex-col gap-4" onsubmit={submit}>
        {#if phoneForm}
            <!-- Phones: the customer first, as chips of the most recent ones. -->
            <div class="order-1 flex flex-col gap-2">
                <span class="text-sm font-medium text-[var(--stor-ink)]">To</span>
                <ChoiceChips label="Customer" options={customerChips} value={form.customerId} onChange={chooseCustomer} more={customerChips.length ? "More" : "Choose"} onMore={() => (customersOpen = !customersOpen)} moreActive={customersOpen} />
                {#if customersOpen || customerChips.length === 0}
                    <div class="flex items-center gap-2">
                        <Select class="min-w-0 flex-1" value={form.customerId} options={customerOptions} onValueChange={(value) => { chooseCustomer(value); customersOpen = false; }} />
                        {#if onCreateParty}
                            <Button type="button" variant="secondary" size="icon" aria-label="New customer" onclick={() => togglePartyEditor("customer")}><IconPlus class="h-4 w-4" /></Button>
                        {/if}
                    </div>
                {/if}
            </div>
        {/if}
        {#if importMode}
            <InvoiceImportPanel
                onFileSelected={handleImportFileSelected}
                onExtracted={applyImport}
                disabled={saving}
            />
            {#if importNotice}
                <p class="text-xs leading-5 text-[var(--stor-muted-text)]" role="status">{importNotice}</p>
            {/if}
        {/if}

        {#if phoneForm && !defaultsOpen}
            <div class="order-3"><FoldLine bind:open={defaultsOpen} summary={defaultsSummary} /></div>
        {/if}
        <Field label="Invoice number" htmlFor="invoice-number" class={phoneForm ? (defaultsOpen ? "order-3" : "hidden") : ""}>
            <Input
                id="invoice-number"
                autofocus={!importMode}
                placeholder="e.g. INV-2026-001"
                bind:value={form.invoiceNumber}
            />
        </Field>

        {#if phoneForm && defaultsOpen}
            <div class="order-3 flex flex-col gap-3">
                <ChoiceChips label="Document state" options={[{ value: "draft", label: "Draft" }, { value: "issued", label: "Issued" }]} value={form.documentState} onChange={(value) => (form.documentState = value as "draft" | "issued")} />
                <ChoiceChips label="VAT" options={[{ value: "true", label: "VAT applies" }, { value: "false", label: "No VAT" }]} value={form.vatApplicable} onChange={(value) => (form.vatApplicable = value as "" | "true" | "false")} />
                <ChoiceChips label="Payment term" options={[{ value: 7, label: "7 days" }, { value: 14, label: "14 days" }, { value: 30, label: "30 days" }]} value={Number(form.paymentTermDays)} onChange={(value) => (form.paymentTermDays = value)} />
            </div>
        {/if}
        <div class="grid gap-4 sm:grid-cols-2 {phoneForm ? 'hidden' : ''}">
            <Field
                label="Document state"
                htmlFor="invoice-document-state"
                hint={importMode
                    ? "Imported invoices are recorded as issued."
                    : "Issued documents use the invoice heading, independently of delivery and payment."}
            >
                {#if importMode}
                    <Select id="invoice-document-state" value={form.documentState} disabled options={[{value: "draft", label: "Draft"}, {value: "issued", label: "Issued"}]} />
                {:else}
                    <Select id="invoice-document-state" value={form.documentState} onValueChange={(value) => form.documentState = value as "draft" | "issued"} options={[{value: "draft", label: "Draft"}, {value: "issued", label: "Issued"}]} />
                {/if}
            </Field>
            <Field label="VAT applicability" htmlFor="invoice-vat-applicable">
                <Select id="invoice-vat-applicable" value={form.vatApplicable} onValueChange={(value) => form.vatApplicable = value as "" | "true" | "false"} options={[{value: "", label: "Choose..."}, {value: "true", label: "VAT applies"}, {value: "false", label: "VAT does not apply"}]} />
            </Field>
        </div>

        <div class="grid gap-4 sm:grid-cols-2 {phoneForm ? (defaultsOpen ? 'order-3' : 'hidden') : ''}">
            <Field
                label="Supplier"
                htmlFor="invoice-supplier"
                hint={importMode && suggestedSupplier && !form.supplierId
                    ? `New supplier "${suggestedSupplier.name}" will be created.`
                    : onCreateParty && !hasParties
                      ? "No parties yet — add one."
                      : ""}
            >
                <div class="flex items-center gap-2">
                    <Select
                        id="invoice-supplier"
                        class="min-w-0 flex-1"
                        value={form.supplierId}
                        options={supplierOptions}
                        onValueChange={(value) => (form.supplierId = value)}
                    />
                    {#if onUpdateParty && form.supplierId}
                        <Button
                            type="button"
                            variant="secondary"
                            size="icon"
                            aria-label="Edit supplier"
                            title="Edit this party"
                            aria-expanded={editingParty?.side === "supplier"}
                            onclick={() => togglePartyEdit("supplier")}
                        >
                            <IconPencil class="h-4 w-4" />
                        </Button>
                    {/if}
                    {#if onCreateParty}
                        <Button
                            type="button"
                            variant="secondary"
                            size="icon"
                            aria-label="Add supplier"
                            title="Add supplier"
                            aria-expanded={partyEditor === "supplier"}
                            onclick={() => togglePartyEditor("supplier")}
                        >
                            <IconPlus class="h-4 w-4" />
                        </Button>
                    {/if}
                </div>
            </Field>
            <Field
                class={phoneForm ? "hidden" : ""}
                label="Customer"
                htmlFor="invoice-customer"
                hint={importMode && suggestedCustomer && !form.customerId
                    ? `New customer "${suggestedCustomer.name}" will be created.`
                    : onCreateParty && !hasParties
                      ? "No parties yet — add one."
                      : ""}
            >
                <div class="flex items-center gap-2">
                    <Select
                        id="invoice-customer"
                        class="min-w-0 flex-1"
                        value={form.customerId}
                        options={customerOptions}
                        onValueChange={(value) => (form.customerId = value)}
                    />
                    {#if onUpdateParty && form.customerId}
                        <Button
                            type="button"
                            variant="secondary"
                            size="icon"
                            aria-label="Edit customer"
                            title="Edit this party"
                            aria-expanded={editingParty?.side === "customer"}
                            onclick={() => togglePartyEdit("customer")}
                        >
                            <IconPencil class="h-4 w-4" />
                        </Button>
                    {/if}
                    {#if onCreateParty}
                        <Button
                            type="button"
                            variant="secondary"
                            size="icon"
                            aria-label="Add customer"
                            title="Add customer"
                            aria-expanded={partyEditor === "customer"}
                            onclick={() => togglePartyEditor("customer")}
                        >
                            <IconPlus class="h-4 w-4" />
                        </Button>
                    {/if}
                </div>
            </Field>
        </div>

        {#if partyEditor && onCreateParty}
            <div class="max-md:order-1"><InvoicePartyForm
                role={partyEditor}
                title={partyEditor === "supplier" ? "New supplier" : "New customer"}
                submitLabel={partyEditor === "supplier" ? "Add supplier" : "Add customer"}
                onSave={saveCreatedParty}
                onSaved={attachCreatedParty}
                onCancel={() => (partyEditor = null)}
            /></div>
        {:else if editingParty && onUpdateParty}
            <InvoicePartyForm
                initial={editingParty.party}
                title="Edit party"
                onSave={saveEditedParty}
                onSaved={() => (editingParty = null)}
                onCancel={() => (editingParty = null)}
            />
        {/if}

        {#if form.supplierId && (!phoneForm || defaultsOpen)}
            <details class="max-md:order-3 rounded-xl bg-[var(--stor-surface-muted)] p-3">
                <summary class="cursor-pointer text-sm font-medium">Supplier details on this invoice</summary>
                <div class="mt-3"><InvoicePartyFields bind:value={supplierDetails} /></div>
            </details>
        {/if}
        {#if form.customerId && (!phoneForm || defaultsOpen)}
            <details class="max-md:order-3 rounded-xl bg-[var(--stor-surface-muted)] p-3">
                <summary class="cursor-pointer text-sm font-medium">Customer details on this invoice</summary>
                <div class="mt-3"><InvoicePartyFields bind:value={customerDetails} /></div>
            </details>
        {/if}
        <section class="order-2 space-y-2">
            <div class="flex items-center justify-between gap-3">
                <div class="text-sm font-semibold text-[var(--stor-ink)]">{phoneForm ? "Items" : "Line items"}</div>
                <Button type="button" onclick={addItem} variant="ghost" size="sm">
                    Add item
                </Button>
            </div>

            <div class="space-y-2">
                {#each form.items as item, index}
                    <div class="space-y-2 rounded-xl bg-[var(--stor-surface-muted)] p-2">
                        <div class="grid grid-cols-[minmax(0,1fr)_2.25rem] items-start gap-2">
                            <Input
                                aria-label={`Line ${index + 1} description`}
                                placeholder="Description"
                                bind:value={item.description}
                                class="min-w-0 px-2 py-2 text-sm"
                            />
                            <Button
                                type="button"
                                onclick={() => removeItem(index)}
                                disabled={form.items.length <= 1}
                                variant="ghost"
                                size="icon"
                                class="text-[var(--stor-muted-text)] hover:bg-red-50 hover:text-red-600"
                                aria-label={`Remove line ${index + 1}`}
                            >
                                <IconClose class="h-4 w-4" />
                            </Button>
                        </div>

                        <div class="grid grid-cols-2 gap-2">
                            <label class="block text-xs font-medium text-[var(--stor-muted-text)]">
                                Quantity
                                <Input
                                    aria-label={`Line ${index + 1} quantity`}
                                    type="number"
                                    min="0.01"
                                    step="0.01"
                                    bind:value={item.quantity}
                                    class="mt-1 px-2 py-2 text-right text-sm"
                                />
                            </label>
                            <label class="block text-xs font-medium text-[var(--stor-muted-text)]">
                                Unit price
                                <div class="relative mt-1">
                                    <Input
                                        aria-label={`Line ${index + 1} unit price`}
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        bind:value={item.unitPrice}
                                        class="px-2 py-2 pr-7 text-right text-sm"
                                    />
                                    <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-[var(--stor-muted-text)]">Kč</span>
                                </div>
                            </label>
                        </div>
                    </div>
                {/each}
            </div>

            <div class="flex items-center justify-end gap-2 text-sm">
                <span class="text-[var(--stor-muted-text)]">Total</span>
                <span class="tabular-nums text-lg font-semibold text-[var(--stor-ink)]">{formatAmount(totalAmount)}</span>
            </div>
        </section>

        <div class="grid gap-4 sm:grid-cols-2 {phoneForm ? (defaultsOpen ? 'order-3' : 'hidden') : ''}">
            <Field label="Issue date" htmlFor="invoice-issue-date" hint="Defaults to today.">
                <DatePicker
                    id="invoice-issue-date"
                    bind:value={form.issueDate}
                    placeholder="Choose issue date"
                    onValueChange={(value) => {
                        if (!invoice && value && !taxPointDateTouched) {
                            form.taxPointDate = value;
                        }
                    }}
                />
            </Field>
            <Field
                label="DUZP"
                htmlFor="invoice-tax-point-date"
                hint="Datum uskutečnění zdanitelného plnění."
            >
                <DatePicker
                    id="invoice-tax-point-date"
                    bind:value={form.taxPointDate}
                    placeholder="Choose tax point date"
                    onValueChange={() => {
                        taxPointDateTouched = true;
                    }}
                />
            </Field>
            <Field
                label="Payment term (days)"
                htmlFor="invoice-payment-term"
                hint={dueDateHint}
            >
                <Input
                    id="invoice-payment-term"
                    type="number"
                    min="0"
                    step="1"
                    placeholder="e.g. 14"
                    bind:value={form.paymentTermDays}
                    class="text-right"
                />
            </Field>
        </div>

        {#if phoneForm && !notesOpen}
            <div class="order-4"><FoldLine bind:open={notesOpen} tone="link" summary="Notes" /></div>
        {/if}
        <Field label="Notes" htmlFor="invoice-description" hint="Optional" class={phoneForm ? (notesOpen ? "order-4" : "hidden") : ""}>
            <Textarea
                id="invoice-description"
                rows={3}
                placeholder="Internal notes about this invoice..."
                bind:value={form.description}
            />
        </Field>

        {#if errorMessage}
            <div class="max-md:order-5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {errorMessage}
            </div>
        {/if}

        </form>
    {#snippet footer()}
            <Button variant="secondary" size="sm" onclick={onClose} disabled={saving}>
                Cancel
            </Button>
            <Button type="submit" form={drawerFormId0} disabled={saving}>
                {saving
                    ? importMode ? "Importing..." : "Saving..."
                    : importMode
                      ? "Import invoice"
                      : invoice
                        ? "Save changes"
                        : phoneForm && totalAmount > 0
                          ? `Create invoice · ${formatAmount(totalAmount)} Kč`
                          : "Create invoice"}
            </Button>

    {/snippet}
</CommandDrawer>
