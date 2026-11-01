import { describe, expect, it } from 'vitest';
import { dueRelative, partyInitials } from './format.js';

describe('dueRelative', () => {
    it('counts days ahead and behind', () => {
        expect(dueRelative('2026-11-07', '2026-11-01', 'sent')).toEqual({ text: 'in 6 days', late: false });
        expect(dueRelative('2026-11-02', '2026-11-01', 'sent')).toEqual({ text: 'in 1 day', late: false });
        expect(dueRelative('2026-10-28', '2026-11-01', 'overdue')).toEqual({ text: '4 days late', late: true });
        expect(dueRelative('2026-10-31', '2026-11-01', 'unpaid')).toEqual({ text: '1 day late', late: true });
    });

    it('says today on the due date', () => {
        expect(dueRelative('2026-11-01', '2026-11-01', 'sent')).toEqual({ text: 'today', late: false });
    });

    it('stays quiet for settled or undated invoices', () => {
        expect(dueRelative('2026-10-20', '2026-11-01', 'paid')).toBeNull();
        expect(dueRelative('', '2026-11-01', 'sent')).toBeNull();
    });
});

describe('partyInitials', () => {
    it('takes two initials and skips legal suffixes', () => {
        expect(partyInitials('Kovárna Studio s.r.o.')).toBe('KS');
        expect(partyInitials('Lumen Digital, a.s.')).toBe('LD');
        expect(partyInitials('Pekárna Vlna')).toBe('PV');
        expect(partyInitials('Cloudbase Ltd')).toBe('C');
    });
});
