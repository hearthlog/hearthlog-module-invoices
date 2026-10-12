import { describe, expect, it } from 'vitest';
import { invoiceFiles } from './fork-files.js';

const APP = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const CHILD = '33333333-3333-4333-8333-333333333333';
const INVOICE = '44444444-4444-4444-8444-444444444444';
const FILE = '55555555-5555-4555-8555-555555555555';
const scope = { appId: APP, sourceLogId: SOURCE, childLogId: CHILD };

describe('invoice fork files', () => {
    it('re-keys invoice files from the source log to the child and marks only uploaded ones required', () => {
        const files = invoiceFiles([
            { type: 'INVOICE_ADDED', payload: { id: INVOICE, file_id: FILE, storage_status: 'uploaded' } },
            { type: 'RECEIVED_INVOICE_ADDED', payload: { id: INVOICE, fileId: FILE, storageStatus: 'pending' } },
            { type: 'CALENDAR_EVENT_ADDED', payload: { id: INVOICE } },
        ], scope);
        expect(files).toEqual([
            { bucket: 'INVOICE_PDFS', sourceKey: `issued/v1/${APP}/${SOURCE}/${INVOICE}/${FILE}`, childKey: `issued/v1/${APP}/${CHILD}/${INVOICE}/${FILE}`, required: true },
            { bucket: 'INVOICE_PDFS', sourceKey: `received/v1/${APP}/${SOURCE}/${INVOICE}/${FILE}`, childKey: `received/v1/${APP}/${CHILD}/${INVOICE}/${FILE}`, required: false },
        ]);
    });

    it('ignores invoice events without a valid id', () => {
        expect(invoiceFiles([{ type: 'INVOICE_ADDED', payload: { id: 'x', file_id: FILE } }], scope)).toEqual([]);
    });
});
