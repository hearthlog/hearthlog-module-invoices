/** Invoices' read repositories, added to `queryDatabase` by the composer. */

import type { ReadModelSession } from '@hearthlog/sdk/data';
import { createInvoiceAttentionRepository } from './attention.js';
import { createInvoiceRepository } from './invoices.js';

export function createRepositories(session: ReadModelSession) {
    return {
        invoices: createInvoiceRepository(session),
        invoiceAttention: createInvoiceAttentionRepository(session),
    };
}
