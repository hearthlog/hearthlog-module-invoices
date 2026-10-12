import { startInvoicePdfCleanupCoordinator } from './api/invoice-pdf-cache.js';
import { startIssuedFileCoordinator } from './invoices/issued-file-store.js';
import { startReceivedPdfCoordinator } from './invoices/received-file-store.js';

/** Invoices keeps generated PDFs tidy and uploads pending originals in the background, on every page. */
export function start(): () => void {
    const stops = [startInvoicePdfCleanupCoordinator(), startReceivedPdfCoordinator(), startIssuedFileCoordinator()];
    return () => { for (const stop of stops) if (typeof stop === 'function') stop(); };
}
