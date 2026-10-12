import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';
import { RECEIVED_INVOICE_DDL } from '@hearthlog/sdk/data';
import { createReadModelSession, type ReadModelDatabase } from '@hearthlog/sdk/testing';
import { createInvoiceRepository } from './invoices.js';

/**
 * The expense type history rule: the type last used for the same supplier,
 * decided by IČO first and by name otherwise, inside the active tenant and log.
 */

const databases: Array<Kysely<ReadModelDatabase>> = [];
afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

function wrap(statement: StatementSync, query: string) {
    return {
        reader: /^\s*(?:PRAGMA|SELECT|WITH|EXPLAIN)\b/i.test(query),
        all: (parameters: ReadonlyArray<unknown>) => statement.all(...parameters as SQLInputValue[]),
        run: (parameters: ReadonlyArray<unknown>) => statement.run(...parameters as SQLInputValue[]),
        iterate: (parameters: ReadonlyArray<unknown>) => statement.iterate(...parameters as SQLInputValue[]),
    };
}

type Seed = { id: string; name: string; ico?: string; type: string; at?: string; tenant?: string; items?: unknown[] };

function repository(seed: Seed[]) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(RECEIVED_INVOICE_DDL);
    const insert = sqlite.prepare(`INSERT INTO received_invoices
        (tenant_id, log_id, id, supplier_name, supplier_ico, expense_type, items, file_id, file_name, size_bytes, updated_at)
        VALUES (?, 'log-a', ?, ?, ?, ?, ?, 'f', 'f.pdf', 1, ?)`);
    for (const row of seed) {
        insert.run(row.tenant ?? 'tenant-a', row.id, row.name, row.ico ?? '', row.type, JSON.stringify(row.items ?? []), row.at ?? '2026-09-01 10:00:00');
    }
    const db = new Kysely<ReadModelDatabase>({
        dialect: new SqliteDialect({ database: { close: () => sqlite.close(), prepare: (query: string) => wrap(sqlite.prepare(query), query) } as never }),
    });
    databases.push(db);
    return createInvoiceRepository(createReadModelSession(db, {
        schema: 'main',
        scope: { tenantId: 'tenant-a', logId: 'log-a' },
        view: { effectiveNow: '2026-10-03T12:00:00.000Z' },
    }));
}

describe('expenseTypeFromHistory', () => {
    it('uses the last type for the same IČO, ahead of the name', async () => {
        const invoices = repository([
            { id: 'old', name: 'JetBrains', ico: '123', type: 'equipment', at: '2026-01-01 10:00:00' },
            { id: 'new', name: 'JetBrains s.r.o.', ico: '123', type: 'software', at: '2026-06-01 10:00:00' },
            { id: 'same-name', name: 'Acme', type: 'travel', at: '2026-09-01 10:00:00' },
        ]);
        expect(await invoices.expenseTypeFromHistory([
            { id: 'draft', supplierIco: '123', supplierName: 'Acme' },
        ])).toEqual([{ id: 'draft', expenseType: 'software', via: 'ico' }]);
    });

    it('falls back to the name, ignoring case and spaces, and skips untyped and other tenants', async () => {
        const invoices = repository([
            { id: 'a', name: 'Acme', type: 'travel' },
            { id: 'untyped', name: 'Beta', type: '' },
            { id: 'other', name: 'Gamma', type: 'marketing', tenant: 'tenant-b' },
        ]);
        expect(await invoices.expenseTypeFromHistory([
            { id: 'x', supplierIco: '', supplierName: ' acme ' },
            { id: 'y', supplierIco: '', supplierName: 'Beta' },
            { id: 'z', supplierIco: '', supplierName: 'Gamma' },
        ])).toEqual([{ id: 'x', expenseType: 'travel', via: 'name' }]);
    });

    it('never matches an invoice with itself', async () => {
        const invoices = repository([{ id: 'only', name: 'Acme', type: 'travel' }]);
        expect(await invoices.expenseTypeFromHistory([{ id: 'only', supplierIco: '', supplierName: 'Acme' }])).toEqual([]);
    });
});

describe('untyped received invoices', () => {
    it('lists invoices without a type with up to 10 line descriptions and counts them', async () => {
        const lines = Array.from({ length: 12 }, (_, index) => ({ description: `Line ${index}`, quantity: 1, unitPrice: 1, vatRate: 21 }));
        const invoices = repository([
            { id: 'u1', name: 'Acme', type: '', items: lines },
            { id: 't1', name: 'Beta', type: 'travel' },
        ]);
        const rows = await invoices.getReceivedWithoutExpenseType();
        expect(rows.map((row) => row.id)).toEqual(['u1']);
        expect(rows[0].lines).toHaveLength(10);
        expect(await invoices.countReceivedWithoutExpenseType()).toBe(1);
    });
});
