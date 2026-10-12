import { describe, expect, it, vi } from 'vitest';
import { handleAiDecisionsRequest, type AiDecisionsEnv } from '@hearthlog/sdk/server-testing';
import { LedgerAdminAuthorizationError } from '@hearthlog/sdk/server';
import invoicesServer from './index';

const handle = (request: Request, env: AiDecisionsEnv, authorize?: Parameters<typeof handleAiDecisionsRequest>[3]) =>
    handleAiDecisionsRequest(request, env, [invoicesServer], authorize);

const APP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_LOG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const URL_BASE = 'https://stor.example';

function ledger() {
    return {
        fetch: async (request: Request) => {
            const { pathname } = new URL(request.url);
            if (pathname === '/session') return Response.json({ appId: APP });
            if (pathname === `/logs/${LOG}`) return Response.json({ id: LOG });
            return new Response('{}', { status: 404 });
        },
    };
}

function env(overrides: Partial<AiDecisionsEnv> = {}, answer: unknown = { answers: { answer: { food: 0.97, none: 0.03 } } }): AiDecisionsEnv {
    return {
        CF_ACCESS_APP_AUD: 'aud',
        CF_ACCESS_TEAM_DOMAIN: 'https://team.example',
        LEDGER: ledger(),
        LEDGER_AUTH_TOKEN: 'token',
        STOR_AUTHORIZED_EMAILS: 'a@example.com',
        AI: { run: vi.fn(async () => answer) },
        AI_CAPABILITIES: 'invoice-expense-type',
        ...overrides,
    } as AiDecisionsEnv;
}

const allow = async () => ({ email: 'a@example.com' }) as never;
const deny = async () => { throw new LedgerAdminAuthorizationError(); };

function post(body: unknown, { log = LOG, capability = 'category-pick', headers = {} }: { log?: string; capability?: string; headers?: Record<string, string> } = {}) {
    return new Request(`${URL_BASE}/api/ai/v1/logs/${log}/decisions/${capability}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

describe('invoice expense-type decisions', () => {
    it('validates invoice items per capability', async () => {
        const config = env({ AI_CAPABILITIES: 'invoice-expense-type' }, { answers: { answer: { software: 0.93 } } });
        const response = await handle(post({ items: [{ id: 'i1', supplier: 'JetBrains', description: 'IDE licence', lines: ['IntelliJ'] }] }, { capability: 'invoice-expense-type' }), config, allow);
        expect(await response.json()).toMatchObject({ decisions: [{ id: 'i1', option: 'software', probability: 0.93 }] });
        const tooManyLines = { id: 'i2', supplier: 'A', description: '', lines: Array.from({ length: 11 }, () => 'x') };
        expect((await handle(post({ items: [tooManyLines] }, { capability: 'invoice-expense-type' }), config, allow)).status).toBe(400);
    });
});
