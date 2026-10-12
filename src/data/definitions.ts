/**
 * Invoices' persisted entities (issued and received invoices and the party
 * directory). Their names, tables, event prefixes, and fields are deployed data
 * contracts: never rename them.
 */

import type { EntityDefinition } from '@hearthlog/sdk/entities';

export const ENTITY_DEFINITIONS: EntityDefinition[] = [
    {
        name: "invoice",
        feature: "invoices",
        table: "invoices",
        fields: [
            {
                name: "invoice_number",
                type: "string",
                payloadKey: "invoice_number",
                required: true,
            },
            {
                name: "amount",
                type: "number",
                payloadKey: "amount",
                required: true,
            },
            { name: "supplier_id", type: "string", payloadKey: "supplier_id" },
            { name: "customer_id", type: "string", payloadKey: "customer_id" },
            { name: "description", type: "string", payloadKey: "description" },
            {
                name: "issue_date",
                type: "datetime",
                payloadKey: "issue_date",
                default: "datetime('now')",
            },
            { name: "due_date", type: "datetime", payloadKey: "due_date" },
            {
                name: "tax_point_date",
                type: "datetime",
                payloadKey: "tax_point_date",
            },
            {
                name: "document_state",
                type: "string",
                payloadKey: "document_state",
                optionalInPayload: true,
            },
            {
                name: "document_uuid",
                type: "string",
                payloadKey: "document_uuid",
                optionalInPayload: true,
            },
            {
                name: "vat_applicable",
                type: "boolean",
                payloadKey: "vat_applicable",
                optionalInPayload: true,
            },
            {
                name: "electronic_agreement_reference",
                type: "string",
                payloadKey: "electronic_agreement_reference",
                optionalInPayload: true,
            },
            {
                name: "supplier_snapshot",
                type: "string",
                payloadKey: "supplier_snapshot",
                optionalInPayload: true,
            },
            {
                name: "customer_snapshot",
                type: "string",
                payloadKey: "customer_snapshot",
                optionalInPayload: true,
            },
            {
                name: "payment_snapshot",
                type: "string",
                payloadKey: "payment_snapshot",
                optionalInPayload: true,
            },
            {
                name: "status",
                type: "string",
                payloadKey: "status",
                default: "draft",
            },
            {
                name: "items",
                type: "string",
                payloadKey: "items",
                default: "[]",
            },
            // Imported originals: an issued invoice created outside the app keeps
            // its source PDF (and embedded ISDOC) like a received invoice. A new
            // file id is a new immutable version, so history can recover older
            // documents.
            {
                name: "file_id",
                type: "string",
                payloadKey: "file_id",
                default: "",
                optionalInPayload: true,
            },
            {
                name: "file_name",
                type: "string",
                payloadKey: "file_name",
                default: "",
                optionalInPayload: true,
            },
            {
                name: "size_bytes",
                type: "number",
                payloadKey: "size_bytes",
                default: 0,
                optionalInPayload: true,
            },
            {
                name: "storage_status",
                type: "string",
                payloadKey: "storage_status",
                default: "",
                optionalInPayload: true,
            },
            {
                name: "isdoc_file_id",
                type: "string",
                payloadKey: "isdoc_file_id",
                default: "",
                optionalInPayload: true,
            },
            {
                name: "isdoc_file_name",
                type: "string",
                payloadKey: "isdoc_file_name",
                default: "",
                optionalInPayload: true,
            },
            {
                name: "isdoc_size_bytes",
                type: "number",
                payloadKey: "isdoc_size_bytes",
                default: 0,
                optionalInPayload: true,
            },
            {
                name: "isdoc_storage_status",
                type: "string",
                payloadKey: "isdoc_storage_status",
                default: "",
                optionalInPayload: true,
            },
            // Provenance of an imported document: reader metadata and warnings.
            {
                name: "extraction_source",
                type: "string",
                payloadKey: "extraction_source",
                default: "",
                optionalInPayload: true,
            },
            {
                name: "extraction_metadata",
                type: "string",
                payloadKey: "extraction_metadata",
                default: "",
                optionalInPayload: true,
            },
        ],
        calendar: {
            key: "inv-due",
            dateField: "due_date",
            titleField: "customer_snapshot#name",
            titleFallbacks: ["description", "invoice_number"],
            subtitleField: "invoice_number",
            label: "Invoice",
            presentation: { icon: "file-document-outline", tone: "negative", href: "/invoices?invoice={id}", rank: 40 },
            group: { id: "invoices", label: "Invoices", icon: "file-document-outline" },
        },
        indexes: [
            {
                name: "idx_invoices_scope_issue_date",
                columns: ["tenant_id", "log_id", "issue_date"],
            },
            {
                name: "idx_invoices_scope_due_date",
                columns: ["tenant_id", "log_id", "due_date"],
            },
            {
                name: "idx_invoices_scope_tax_point_date",
                columns: ["tenant_id", "log_id", "tax_point_date"],
            },
            { name: "idx_invoices_issue_date", columns: ["issue_date"] },
            { name: "idx_invoices_status", columns: ["status"] },
        ],
    },
    {
        name: "received_invoice",
        feature: "invoices",
        displayName: "Received Invoice",
        table: "received_invoices",
        fields: [
            {
                name: "supplier_id",
                type: "string",
                payloadKey: "supplierId",
                default: "",
            },
            {
                name: "supplier_name",
                type: "string",
                payloadKey: "supplierName",
                default: "",
            },
            {
                name: "supplier_ico",
                type: "string",
                payloadKey: "supplierIco",
                default: "",
            },
            {
                name: "supplier_dic",
                type: "string",
                payloadKey: "supplierDic",
                default: "",
            },
            {
                name: "invoice_number",
                type: "string",
                payloadKey: "invoiceNumber",
                default: "",
            },
            // `amount` stays the gross payable total; subtotal and vat_total carry
            // the document breakdown extracted from ISDOC or an LLM.
            { name: "amount", type: "number", default: 0 },
            { name: "subtotal", type: "number", default: 0 },
            {
                name: "vat_total",
                type: "number",
                payloadKey: "vatTotal",
                default: 0,
            },
            { name: "currency", type: "string", default: "CZK" },
            {
                name: "vat_applicable",
                type: "boolean",
                payloadKey: "vatApplicable",
                optionalInPayload: true,
            },
            { name: "items", type: "string", default: "[]" },
            {
                name: "issue_date",
                type: "datetime",
                payloadKey: "issueDate",
                default: "",
            },
            {
                name: "due_date",
                type: "datetime",
                payloadKey: "dueDate",
                default: "",
            },
            {
                name: "tax_point_date",
                type: "datetime",
                payloadKey: "taxPointDate",
                default: "",
            },
            {
                name: "paid_at",
                type: "datetime",
                payloadKey: "paidAt",
                default: "",
            },
            { name: "status", type: "string", default: "review" },
            { name: "description", type: "string", default: "" },
            {
                name: "bank_account",
                type: "string",
                payloadKey: "bankAccount",
                default: "",
            },
            {
                name: "variable_symbol",
                type: "string",
                payloadKey: "variableSymbol",
                default: "",
            },
            {
                name: "file_id",
                type: "string",
                payloadKey: "fileId",
                required: true,
            },
            {
                name: "file_name",
                type: "string",
                payloadKey: "fileName",
                required: true,
            },
            {
                name: "size_bytes",
                type: "number",
                payloadKey: "sizeBytes",
                required: true,
            },
            {
                name: "storage_status",
                type: "string",
                payloadKey: "storageStatus",
                default: "queued",
            },
            // Immutable ISDOC XML embedded in the supplier PDF, kept alongside
            // the original PDF. Empty when the document carries no ISDOC.
            {
                name: "isdoc_file_id",
                type: "string",
                payloadKey: "isdocFileId",
                default: "",
            },
            {
                name: "isdoc_file_name",
                type: "string",
                payloadKey: "isdocFileName",
                default: "",
            },
            {
                name: "isdoc_size_bytes",
                type: "number",
                payloadKey: "isdocSizeBytes",
                default: 0,
            },
            {
                name: "isdoc_storage_status",
                type: "string",
                payloadKey: "isdocStorageStatus",
                default: "",
            },
            // Provenance of the extracted fields. `'ai'` is reserved for the
            // LLM phase; `'isdoc'` and `'manual'` are used by the deterministic one.
            {
                name: "extraction_source",
                type: "string",
                payloadKey: "extractionSource",
                default: "",
            },
            {
                name: "extraction_metadata",
                type: "string",
                payloadKey: "extractionMetadata",
                default: "",
            },
            // One value of the fixed list in `src/lib/invoices/expense-types.ts`;
            // empty means not set.
            {
                name: "expense_type",
                type: "string",
                payloadKey: "expenseType",
                default: "",
                optionalInPayload: true,
            },
        ],
        calendar: {
            key: "rin-due",
            dateField: "due_date",
            titleField: "supplier_name",
            titleFallbacks: ["description", "invoice_number", "file_name"],
            subtitleField: "invoice_number",
            label: "Invoice",
            presentation: { icon: "file-document-outline", tone: "negative", href: "/invoices?tab=received&invoice={id}", rank: 45 },
            group: { id: "invoices", label: "Invoices", icon: "file-document-outline" },
        },
        indexes: [
            {
                name: "idx_received_invoices_scope_issue",
                columns: ["tenant_id", "log_id", "issue_date"],
            },
            {
                name: "idx_received_invoices_scope_tax_point",
                columns: ["tenant_id", "log_id", "tax_point_date"],
            },
            {
                name: "idx_received_invoices_scope_paid_at",
                columns: ["tenant_id", "log_id", "paid_at"],
            },
            {
                name: "idx_received_invoices_scope_due",
                columns: ["tenant_id", "log_id", "due_date"],
            },
            {
                name: "idx_received_invoices_scope_status",
                columns: ["tenant_id", "log_id", "status"],
            },
        ],
    },
    {
        name: "invoiceparty",
        feature: "invoices",
        table: "invoice_parties",
        fields: [
            {
                name: "name",
                type: "string",
                payloadKey: "name",
                required: true,
            },
            {
                name: "street",
                type: "string",
                payloadKey: "street",
                required: true,
            },
            {
                name: "city",
                type: "string",
                payloadKey: "city",
                required: true,
            },
            { name: "ico", type: "string", payloadKey: "ico", required: true },
            { name: "dic", type: "string", payloadKey: "dic" },
            {
                name: "bank_account",
                type: "string",
                payloadKey: "bank_account",
            },
            {
                name: "registration",
                type: "string",
                payloadKey: "registration",
                optionalInPayload: true,
            },
            {
                name: "postal_address",
                type: "string",
                payloadKey: "postal_address",
                optionalInPayload: true,
            },
            {
                // A merged duplicate points at its survivor; the file keeps
                // the old id resolvable and the row hidden from pickers.
                name: "merged_into",
                type: "string",
                payloadKey: "merged_into",
                optionalInPayload: true,
                default: "",
            },
        ],
        indexes: [
            {
                name: "idx_invoice_parties_scope_merged",
                columns: ["tenant_id", "log_id", "merged_into"],
            },
        ],
    },
];
