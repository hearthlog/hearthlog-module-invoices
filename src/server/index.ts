import type { ServerModule } from '@hearthlog/sdk/server';
import { invoiceExpenseType } from './expense-type.js';
import { invoiceFiles } from './fork-files.js';
import { handleInvoicePdfRequest } from './invoice-pdf-cache.js';
import { handleIssuedInvoiceFileRequest, handleReceivedInvoiceFileRequest } from './invoice-files.js';
import { proxyInvoiceRendererRequest } from './invoice-renderer.js';
import { handleReceivedInvoiceExtractionRequest } from './received-invoice-extraction.js';

/**
 * Invoices' part of the gateway Worker: the generated-PDF cache and renderer
 * proxy, stored originals (issued and received), AI reading of received
 * invoices, the expense-type decision, and the files a fork carries along.
 * The longer `/api/invoice-generation/logs` prefix is listed first.
 */
const invoices: ServerModule<Env> = {
    id: 'org.stor.invoices',
    routes: [
        { prefix: '/api/invoice-generation/logs', handle: handleInvoicePdfRequest },
        { prefix: '/api/invoice-generation', handle: proxyInvoiceRendererRequest },
        { prefix: '/api/received-invoice-files/v1', handle: handleReceivedInvoiceFileRequest },
        { prefix: '/api/issued-invoice-files/v1', handle: handleIssuedInvoiceFileRequest },
        { prefix: '/api/received-invoice-extraction/v1', handle: handleReceivedInvoiceExtractionRequest },
    ],
    ai: { 'invoice-expense-type': invoiceExpenseType },
    forkFiles: invoiceFiles,
};

export default invoices;
