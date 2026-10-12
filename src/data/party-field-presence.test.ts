import { afterEach, describe, expect, it } from 'vitest';
import { createProjectionTestDatabase, type ProjectionTestDatabase } from '@hearthlog/sdk/testing';

const open: ProjectionTestDatabase[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((fixture) => fixture.destroy()));
});

describe('invoice party field presence', () => {
    it('clears an optional field to NULL on an explicit null and keeps it when the key is omitted', async () => {
        const db = createProjectionTestDatabase({ tables: ['invoice_parties'] });
        open.push(db);
        const entityId = 'invoiceparty:party-1';
        const party = () => db.sqlite.prepare('SELECT name, registration, postal_address FROM invoice_parties').get();
        db.addEvent({ id: 'add', type: 'INVOICEPARTY_ADDED', timestamp: 1_000, entityId, entityVersion: 1, logVersion: 1,
            payload: { id: 'party-1', name: 'Acme', street: 'Main 1', city: 'Brno', ico: '123', registration: 'C 1234', postal_address: 'PO Box 7' } });
        db.addEvent({ id: 'rename', type: 'INVOICEPARTY_UPDATED', timestamp: 2_000, entityId, entityVersion: 2, logVersion: 2,
            payload: { id: 'party-1', name: 'Acme Ltd' } });
        await db.project('invoiceparty', [entityId]);
        expect(party()).toEqual({ name: 'Acme Ltd', registration: 'C 1234', postal_address: 'PO Box 7' });

        db.addEvent({ id: 'clear', type: 'INVOICEPARTY_UPDATED', timestamp: 3_000, entityId, entityVersion: 3, logVersion: 3,
            payload: { id: 'party-1', registration: null } });
        await db.project('invoiceparty', [entityId]);
        expect(party()).toEqual({ name: 'Acme Ltd', registration: null, postal_address: 'PO Box 7' });
    });
});
