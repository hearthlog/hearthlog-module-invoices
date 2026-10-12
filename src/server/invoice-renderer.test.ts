import { describe, expect, it, vi } from 'vitest';
import { LedgerAdminAuthorizationError } from '@hearthlog/sdk/server';
import { proxyInvoiceRendererRequest } from './invoice-renderer.js';

const storAccess = {
    CF_ACCESS_APP_AUD: 'app-audience',
    CF_ACCESS_TEAM_DOMAIN: 'https://stor.cloudflareaccess.com',
    STOR_AUTHORIZED_EMAILS: 'user@example.com',
};

describe('Invoice renderer gateway', () => {
    it('requires a verified Access identity before calling the renderer', async () => {
        const upstream = vi.spyOn(globalThis, 'fetch');
        const response = await proxyInvoiceRendererRequest(
            new Request('https://stor.example/api/invoice-generation/pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            }),
            { ...storAccess, INVOICE_RENDERER_TOKEN: 'renderer-secret', INVOICE_RENDERER_ORIGIN: 'https://renderer.example' },
            async () => {
                throw new LedgerAdminAuthorizationError();
            },
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'invoice_renderer_forbidden' });
        expect(upstream).not.toHaveBeenCalled();
        upstream.mockRestore();
    });
});
