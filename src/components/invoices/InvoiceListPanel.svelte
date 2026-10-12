<script lang="ts">
    import { attention } from "@hearthlog/sdk/runtime";
    import type { InvoiceListRow, InvoiceSelection } from '../../invoices/list-contracts.js';
    import { invoiceStorageLabel } from '../../invoices/invoice-file-store.js';
    import InvoiceBatchTable from './InvoiceBatchTable.svelte';
    import InvoiceActionsMenu from './InvoiceActionsMenu.svelte';
    import InvoiceStatusBadge from './InvoiceStatusBadge.svelte';

    /**
     * Issued invoices are rendered straight from the SQL list projection; this
     * wrapper only supplies the labels, the row snippets and the callbacks.
     */
    let {
        today,
        revision,
        loading,
        selectedId,
        onSelect,
        onEdit,
        onClone,
        onRemove,
        onViewPdf,
        onMarkPaid,
        onDelete,
        onCreate,
        onImport,
    }: {
        today: string;
        revision: number;
        loading: boolean;
        selectedId: string | null;
        onSelect: (row: InvoiceListRow) => void;
        onEdit: (row: InvoiceListRow) => void;
        onClone: (row: InvoiceListRow) => void;
        onRemove: (row: InvoiceListRow) => void;
        onViewPdf: (row: InvoiceListRow) => void;
        onMarkPaid: (selection: InvoiceSelection) => Promise<boolean>;
        onDelete: (selection: InvoiceSelection) => void;
        onCreate: () => void;
        onImport?: () => void;
    } = $props();
</script>

{#snippet statusBadge(row: InvoiceListRow)}
    <InvoiceStatusBadge status={row.status} documentState={row.documentState} />
{/snippet}

{#snippet actions(row: InvoiceListRow)}
    <InvoiceActionsMenu
        label={`invoice ${row.invoiceNumber}`}
        items={[
            { label: 'View details', onSelect: () => onSelect(row) },
            { label: 'View PDF', onSelect: () => onViewPdf(row) },
            { label: 'Edit invoice', commandOnly: true, onSelect: () => onEdit(row) },
            { label: 'Clone invoice', commandOnly: true, onSelect: () => onClone(row) },
            { label: 'Delete', tone: 'danger', commandOnly: true, onSelect: () => onRemove(row) },
        ]}
    />
{/snippet}

<InvoiceBatchTable
    direction="issued"
    overdueCount={attention.badge('invoices.issued')?.count ?? 0}
    {today}
    {revision}
    {loading}
    tableLabel="Invoices"
    activeId={selectedId}
    partyLabel="Customer"
    statusOptions={[
        { value: 'all', label: 'All statuses' },
        { value: 'outstanding', label: 'Outstanding' },
        { value: 'draft', label: 'Draft' },
        { value: 'sent', label: 'Sent' },
        { value: 'paid', label: 'Paid' },
        { value: 'overdue', label: 'Overdue' },
    ]}
    emptyTitle="No invoices yet"
    emptyDescription="Create your first invoice to start tracking billing and payment status."
    storageLabel={invoiceStorageLabel}
    {statusBadge}
    {actions}
    {onSelect}
    {onMarkPaid}
    {onDelete}
    {onCreate}
    {onImport}
/>
