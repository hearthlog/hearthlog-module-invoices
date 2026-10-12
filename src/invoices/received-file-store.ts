import { executeLocalCommand } from "@hearthlog/sdk/data";
import { queryDatabase } from "@hearthlog/sdk/data";
import type { ReceivedInvoice } from "../data/invoices.js";
import {
    createInvoiceFileStore,
    type InvoiceFileKind,
} from "./invoice-file-store.js";

export type ReceivedFileKind = InvoiceFileKind;

/**
 * Original documents of received invoices: the supplier's PDF and the ISDOC
 * XML embedded in it, retained for audit and future re-import.
 */
const store = createInvoiceFileStore<ReceivedInvoice>({
    dbName: "stor-received-invoice-files",
    apiPrefix: "/api/received-invoice-files/v1",
    load: (invoiceId) =>
        queryDatabase((repositories) =>
            repositories.invoices.getReceivedInvoice(invoiceId),
        ),
    markStorageStatus: async (invoice, kind, status) => {
        await executeLocalCommand({
            id: crypto.randomUUID(),
            type: "RECEIVED_INVOICE_UPDATED",
            timestamp: Date.now(),
            payload:
                kind === "isdoc"
                    ? { id: invoice.id, isdocStorageStatus: status }
                    : { id: invoice.id, storageStatus: status },
        });
    },
});

export const validateReceivedPdf = store.validatePdf;
export const validateReceivedIsdoc = store.validateIsdoc;
export const queueReceivedPdf = store.queuePdf;
export const queueReceivedIsdoc = store.queueIsdoc;
export const discardQueuedReceivedFile = store.discardQueuedFile;
export const getReceivedPdf = store.getPdf;
export const getReceivedIsdoc = store.getIsdoc;
export const runReceivedFileUploads = store.runUploads;
export const retryReceivedPdf = store.retryPdf;
export const retryReceivedIsdoc = store.retryIsdoc;
export const startReceivedPdfCoordinator = store.startUploadCoordinator;
