import type { FileContributor, ForkFile } from '@hearthlog/sdk/server';
import { isUuid } from '@hearthlog/sdk/server';

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
}

/** Issued and received invoice PDFs and ISDOC files, keyed by app and log. */
export const invoiceFiles: FileContributor = (events, { appId, sourceLogId, childLogId }) => {
    const files = new Map<string, ForkFile>();
    const known = new Map<string, { pdf?: string; isdoc?: string }>();
    function add(prefix: string, suffix: string, required: boolean): void {
        const sourceKey = `${prefix}/${appId}/${sourceLogId}/${suffix}`;
        const prior = files.get(sourceKey);
        files.set(sourceKey, {
            bucket: 'INVOICE_PDFS',
            sourceKey,
            childKey: `${prefix}/${appId}/${childLogId}/${suffix}`,
            required: required || Boolean(prior?.required),
        });
    }
    // Keep files for all accepted prefix events, including facts a later
    // restore hides. The new log can itself be forked at an earlier point.
    for (const event of events) {
        if (!event.type.startsWith('RECEIVED_INVOICE_') && !event.type.startsWith('INVOICE_')) continue;
        const payload = event.payload;
        const id = text(payload.id);
        if (!id || !isUuid(id)) continue;
        const received = event.type.startsWith('RECEIVED_');
        const prefix = received ? 'received' : 'issued';
        const current = known.get(`${prefix}:${id}`) ?? {};
        const pdf = text(received ? payload.fileId : payload.file_id) ?? current.pdf;
        const isdoc = text(received ? payload.isdocFileId : payload.isdoc_file_id) ?? current.isdoc;
        if (pdf && isUuid(pdf)) {
            add(`${prefix}/v1`, `${id}/${pdf}`, (received ? payload.storageStatus : payload.storage_status) === 'uploaded');
        }
        if (isdoc && isUuid(isdoc)) {
            add(`${prefix}-isdoc/v1`, `${id}/${isdoc}`, (received ? payload.isdocStorageStatus : payload.isdoc_storage_status) === 'uploaded');
        }
        known.set(`${prefix}:${id}`, { pdf, isdoc });
    }
    return [...files.values()];
};
