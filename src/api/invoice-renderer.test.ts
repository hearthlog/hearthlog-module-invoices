import { describe, expect, it } from 'vitest';
import { buildInvoiceGenerationRequest, type InvoiceSource } from './invoice-renderer.js';

function invoice(items: unknown[]): InvoiceSource {
    return {
        id: 'inv-1',
        invoice_number: '2026-011',
        amount: 0,
        supplier_id: null,
        customer_id: null,
        description: null,
        issue_date: '2026-11-03',
        due_date: '2026-11-17',
        tax_point_date: null,
        status: 'draft',
        items: JSON.stringify(items),
    };
}

describe('buildInvoiceGenerationRequest line units', () => {
    it('sends a filled unit as unitCode and omits blank ones', () => {
        const request = buildInvoiceGenerationRequest(
            invoice([
                { description: 'Konzultace', quantity: 12, unit: ' HOD ', unitPrice: 1500, vatRate: 21 },
                { description: 'Licence', quantity: 1, unit: '', unitPrice: 500, vatRate: 21 },
                { description: 'Starší řádek', quantity: 1, unitPrice: 100, vatRate: 21 },
            ]),
            { suppliers: [], customers: [] },
        );

        expect(request.invoice.items[0]?.unitCode).toBe('HOD');
        expect(request.invoice.items[1]).not.toHaveProperty('unitCode');
        expect(request.invoice.items[2]).not.toHaveProperty('unitCode');
    });
});
