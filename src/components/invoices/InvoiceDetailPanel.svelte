<script lang="ts">
    import { SyncStateBadge } from "@hearthlog/sdk/ui";
    import type { Invoice } from "../../data/invoices.js";
    import {
        invoiceDocumentState,
        resolveInvoiceParty,
        type InvoicePartySource,
    } from "../../invoices/document.js";
    import { invoiceTotalPayable } from "../../invoices/amount.js";
    import { formatFileSize } from "../../invoices/format.js";
    import { invoiceStorageLabel } from "../../invoices/invoice-file-store.js";
    import { exportIssuedIsdoc } from "../../invoices/isdoc-source.js";
    import { issuedIsdocAvailability } from "../../invoices/isdoc-status.js";
    import { invoiceStatusOf } from "../../invoices/status.js";
    import InvoiceDetailCard from "./InvoiceDetailCard.svelte";
    import InvoiceDetailLineItems from "./InvoiceDetailLineItems.svelte";
    import InvoiceDetailSummary from "./InvoiceDetailSummary.svelte";
    import InvoiceIsdocCard from "./InvoiceIsdocCard.svelte";
    import InvoiceStatusBadge from "./InvoiceStatusBadge.svelte";
    import { CommandOnly } from "@hearthlog/sdk/ui";
    import { Button } from "@hearthlog/sdk/ui";
    import { appClock } from "@hearthlog/sdk/runtime";
    import { formatMoney } from "@hearthlog/sdk/format";
    import { differenceInCalendarDays, format, parseISO } from "date-fns";
    import IconCheck from "~icons/mdi/check";
    import IconFile from "~icons/mdi/file-document-outline";
    import IconChevronRight from "~icons/mdi/chevron-right";
    import type { Snippet } from "svelte";

    type Party = InvoicePartySource;

    interface InvoiceLineItem {
        description: string;
        quantity: number;
        unitPrice: number;
        vatRate: number;
    }

    let {
        invoice,
        parties = [],
        onMarkPaid,
        onShowPdf,
        menu,
    }: {
        invoice: Invoice;
        /** The unified party directory; merged aliases resolve to survivors. */
        parties?: Party[];
        /** Phones lead with the amount, Mark paid and the PDF. */
        onMarkPaid?: () => void;
        onShowPdf?: () => void;
        /** The invoice's other actions (edit, clone, delete), beside PDF on phones. */
        menu?: Snippet<[Invoice]>;
    } = $props();

    const status = $derived(invoiceStatusOf(invoice));
    let filesOpen = $state(false);
    const STATUS_WORDS: Record<string, string> = { draft: "Draft", sent: "Sent", paid: "Paid", overdue: "Overdue", issued: "Issued" };
    /** "Sent · due Tue 6 Oct, in 2 days" */
    const statusLine = $derived.by(() => {
        const word = STATUS_WORDS[status] ?? status;
        if (!invoice.due_date) return word;
        const due = parseISO(invoice.due_date.slice(0, 10));
        if (Number.isNaN(due.getTime())) return word;
        if (status === "paid") return `${word} · was due ${format(due, "EEE d MMM")}`;
        const days = differenceInCalendarDays(due, appClock.now());
        const when = days === 0 ? "today" : days > 0 ? `in ${days} ${days === 1 ? "day" : "days"}` : `${-days} ${days === -1 ? "day" : "days"} late`;
        return `${word} · due ${format(due, "EEE d MMM")}, ${when}`;
    });

    const supplier = $derived(
        resolveInvoiceParty(invoice, parties, "supplier"),
    );
    const customer = $derived(
        resolveInvoiceParty(invoice, parties, "customer"),
    );

    const items = $derived.by((): InvoiceLineItem[] => {
        if (!invoice.items) return [];
        try {
            const parsed = JSON.parse(invoice.items);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    });

    const subtotal = $derived(
        items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
    );
    const vatTotal = $derived(
        items.reduce(
            (sum, item) =>
                sum +
                (item.quantity * item.unitPrice * (Number(item.vatRate) || 0)) /
                    100,
            0,
        ),
    );
    const total = $derived(invoiceTotalPayable(invoice));
    const vatByRate = $derived.by((): [number, number][] => {
        const byRate = new Map<number, number>();
        for (const item of items) {
            const rate = Number(item.vatRate) || 0;
            byRate.set(
                rate,
                (byRate.get(rate) ?? 0) +
                    (item.quantity * item.unitPrice * rate) / 100,
            );
        }
        return [...byRate.entries()].sort(([left], [right]) => left - right);
    });
    const lineItems = $derived(
        items.map((item) => ({
            ...item,
            net: item.quantity * item.unitPrice,
        })),
    );

    /**
     * The ISDOC of a document created in the app is read out of its PDF, so
     * the card is only offered once the ISDOC profile is complete.
     */
    const isdoc = $derived.by(() => {
        const availability = issuedIsdocAvailability(invoice, {
            suppliers: parties,
            customers: parties,
        });
        if (availability.kind === "unavailable") {
            return {
                fileName: invoice.isdoc_file_name || "invoice.isdoc",
                load: null,
                sizeBytes: 0,
                storageStatus: "",
                note: "",
                missing: availability.gaps,
                message: availability.message,
            };
        }
        const stored = invoice.isdoc_file_id !== "";
        return {
            fileName: stored
                ? invoice.isdoc_file_name || "invoice.isdoc"
                : `${invoice.invoice_number.trim() || "invoice"}.isdoc`,
            load: () => exportIssuedIsdoc(invoice, { suppliers: parties, customers: parties }),
            sizeBytes: stored ? invoice.isdoc_size_bytes : 0,
            storageStatus: stored ? invoice.isdoc_storage_status : "",
            note: stored ? "" : "Read from the invoice PDF.",
            missing: [] as string[],
            message: "",
        };
    });

    function partyLines(party: Party | undefined): string[] {
        if (!party) return [];
        return [
            party.street,
            party.city,
            party.ico ? `IČO: ${party.ico}` : "",
            party.dic ? `DIČ: ${party.dic}` : "",
            party.bank_account ? `Account: ${party.bank_account}` : "",
        ].filter((line) => line.length > 0);
    }
</script>

<div class="space-y-5">
    <!-- Phones: the amount, where it stands, and the two things you do with it. -->
    <section class="md:hidden" aria-label="Invoice total">
        <p class="text-[32px] font-semibold leading-tight tracking-tight tabular-nums text-[var(--stor-ink)]">{formatMoney(total)}</p>
        <p class="mt-1 text-sm font-medium {status === 'overdue' ? 'text-[var(--stor-negative)]' : 'text-[var(--stor-muted-text)]'}">{statusLine}</p>
        <div class="mt-4 flex gap-2">
            {#if status !== "paid" && onMarkPaid}
                <CommandOnly><Button class="h-12 flex-1 text-[15px]" onclick={onMarkPaid}><IconCheck class="h-5 w-5" /> Mark paid</Button></CommandOnly>
            {/if}
            {#if onShowPdf}
                <Button variant="secondary" class="h-12 text-[15px] {status === 'paid' ? 'flex-1' : ''}" onclick={onShowPdf}><IconFile class="h-5 w-5" /> PDF</Button>
            {/if}
            {#if menu}<div class="flex h-12 items-center">{@render menu(invoice)}</div>{/if}
        </div>
    </section>
    <div class="flex flex-wrap items-center gap-2 max-md:hidden">
        <InvoiceStatusBadge
            status={invoiceStatusOf(invoice)}
            documentState={invoiceDocumentState(invoice)}
        />
        <SyncStateBadge entityId={`invoice:${invoice.id}`} />
    </div>

    <div class="max-md:hidden"><InvoiceDetailSummary
        {total}
        {vatTotal}
        issueDate={invoice.issue_date}
        dueDate={invoice.due_date}
        taxPointDate={invoice.tax_point_date}
    /></div>

    <section class="grid gap-3 max-md:hidden sm:grid-cols-2" aria-label="Invoice parties">
        <InvoiceDetailCard
            label="Supplier"
            title={supplier?.name}
            details={partyLines(supplier)}
        />
        <InvoiceDetailCard
            label="Customer"
            title={customer?.name}
            details={partyLines(customer)}
        />
    </section>

    <div class="max-md:hidden">
        <InvoiceDetailLineItems
            items={lineItems}
            {subtotal}
            {total}
            vatByRate={vatByRate}
        />
    </div>

    <!-- Phones fold the parties and dates; the supplier is you, so it comes last. -->
    <div class="divide-y divide-[color-mix(in_srgb,var(--stor-border)_62%,transparent)] border-y border-[color-mix(in_srgb,var(--stor-border)_62%,transparent)] md:hidden">
        <details class="group" open>
            <summary class="flex min-h-14 cursor-pointer list-none items-center gap-3 py-2 [&::-webkit-details-marker]:hidden">
                <span class="min-w-0 flex-1">
                    <span class="block text-[11.5px] font-semibold uppercase tracking-wide text-[var(--stor-muted-text)]">Line items · {items.length}</span>
                    <span class="block truncate text-[15px] text-[var(--stor-ink)]">{formatMoney(subtotal)} before VAT</span>
                </span>
                <IconChevronRight class="h-5 w-5 shrink-0 text-[var(--stor-muted-text)] transition-transform group-open:rotate-90" />
            </summary>
            <ul class="pb-3">
                {#each lineItems as item, index (index)}
                    <li class="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                        <span class="min-w-0"><span class="block text-[var(--stor-ink)]">{item.description}</span><span class="block text-xs text-[var(--stor-muted-text)]">{item.quantity} × {formatMoney(item.unitPrice)} · VAT {item.vatRate} %</span></span>
                        <span class="shrink-0 font-semibold tabular-nums text-[var(--stor-ink)]">{formatMoney(item.net)}</span>
                    </li>
                {/each}
            </ul>
        </details>
        {#each [
            { label: "Customer", line: customer?.name ?? "No customer", party: customer },
            { label: "Dates", line: `Issued ${invoice.issue_date ? format(parseISO(invoice.issue_date.slice(0, 10)), "d MMM") : "—"} · tax point ${invoice.tax_point_date ? format(parseISO(invoice.tax_point_date.slice(0, 10)), "d MMM") : "—"}`, party: undefined },
            { label: "Supplier", line: supplier?.name ?? "No supplier", party: supplier },
        ] as fold (fold.label)}
            <details class="group">
                <summary class="flex min-h-14 cursor-pointer list-none items-center gap-3 py-2 [&::-webkit-details-marker]:hidden">
                    <span class="min-w-0 flex-1">
                        <span class="block text-[11.5px] font-semibold uppercase tracking-wide text-[var(--stor-muted-text)]">{fold.label}</span>
                        <span class="block truncate text-[15px] text-[var(--stor-ink)]">{fold.line}</span>
                    </span>
                    <IconChevronRight class="h-5 w-5 shrink-0 text-[var(--stor-muted-text)] transition-transform group-open:rotate-90" />
                </summary>
                <div class="pb-3 text-sm leading-6 text-[var(--stor-muted-text)]">
                    {#if fold.party}
                        {#each partyLines(fold.party) as line (line)}<p>{line}</p>{/each}
                    {:else}
                        <p>Issued {invoice.issue_date || "—"}</p><p>Due {invoice.due_date || "—"}</p><p>Tax point {invoice.tax_point_date || "—"}</p>
                    {/if}
                </div>
            </details>
        {/each}
    </div>

    <!-- Phones fold the notes and files under one line. -->
    <button type="button" class="flex min-h-12 w-full items-center gap-1 text-sm font-semibold text-[var(--stor-accent-text)] md:hidden" aria-expanded={filesOpen} onclick={() => (filesOpen = !filesOpen)}>
        {invoice.description ? "Notes and files" : "Files"}<IconChevronRight class="h-4 w-4 transition-transform {filesOpen ? 'rotate-90' : ''}" />
    </button>
    <div class="space-y-5 {filesOpen ? '' : 'max-md:hidden'}">
    {#if invoice.description}
        <section aria-label="Invoice notes">
            <h3 class="stor-panel-title border-b border-[var(--stor-border)] pb-2">Notes</h3>
            <p
                class="mt-1 whitespace-pre-wrap text-sm text-[var(--stor-muted-text)]"
            >
                {invoice.description}
            </p>
        </section>
    {/if}

    <div class="space-y-3">
        {#if invoice.file_id}
            <InvoiceDetailCard
                label="Original document"
                title={invoice.file_name || "invoice.pdf"}
                details={[`${formatFileSize(invoice.size_bytes)} · ${invoiceStorageLabel(invoice.storage_status)}`]}
            />
        {/if}
        <InvoiceIsdocCard
            fileName={isdoc.fileName}
            load={isdoc.load}
            sizeBytes={isdoc.sizeBytes}
            storageStatus={isdoc.storageStatus}
            missing={isdoc.missing}
            message={isdoc.message}
            note={isdoc.note}
        />
    </div>
    </div>
</div>
