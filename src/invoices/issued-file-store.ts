import { executeLocalCommand } from "@hearthlog/sdk/data";
import { queryDatabase } from "@hearthlog/sdk/data";
import type { Invoice } from "../data/invoices.js";
import { createInvoiceFileStore } from "./invoice-file-store.js";

/**
 * Original documents of issued invoices that were created outside the app:
 * the source PDF and its ISDOC XML, stored exactly like a received invoice's
 * document so the PDF pane shows the original and history keeps the bytes.
 */
const store = createInvoiceFileStore<Invoice>({
    dbName: "stor-issued-invoice-files",
    apiPrefix: "/api/issued-invoice-files/v1",
    load: (invoiceId) =>
        queryDatabase((repositories) =>
            repositories.invoices.getInvoice(invoiceId),
        ),
    markStorageStatus: async (invoice, kind, status) => {
        await executeLocalCommand({
            id: crypto.randomUUID(),
            type: "INVOICE_UPDATED",
            timestamp: Date.now(),
            payload:
                kind === "isdoc"
                    ? { id: invoice.id, isdoc_storage_status: status }
                    : { id: invoice.id, storage_status: status },
        });
    },
});

export const validateIssuedPdf = store.validatePdf;
export const validateIssuedIsdoc = store.validateIsdoc;
export const queueIssuedPdf = store.queuePdf;
export const queueIssuedIsdoc = store.queueIsdoc;
export const discardQueuedIssuedFile = store.discardQueuedFile;
export const getIssuedPdf = store.getPdf;
export const getIssuedIsdoc = store.getIsdoc;
export const runIssuedFileUploads = store.runUploads;
export const retryIssuedPdf = store.retryPdf;
export const retryIssuedIsdoc = store.retryIsdoc;
export const startIssuedFileCoordinator = store.startUploadCoordinator;
