import { deferPage } from '@hearthlog/sdk/runtime';
import type { ModuleLoadEvent } from '@hearthlog/sdk/runtime';
import type { Invoiceparty } from '../data/invoices.js';
import { queryDatabase, type ReadRepositories } from '@hearthlog/sdk/data';

interface PartyOption {
    id: string;
    name: string;
    street: string;
    city: string;
    ico: string;
    dic: string | null;
    bank_account: string | null;
    registration: string | null;
    postal_address: string | null;
    /** A merged duplicate points at its survivor and is hidden from pickers. */
    merged_into: string | null;
}

function toPartyOption(party: Invoiceparty): PartyOption {
    return {
        id: party.id,
        name: party.name,
        street: party.street,
        city: party.city,
        ico: party.ico,
        dic: party.dic,
        bank_account: party.bank_account,
        registration: party.registration,
        postal_address: party.postal_address,
        merged_into: party.merged_into,
    };
}

async function loadParties(repository: ReadRepositories['invoices']): Promise<{ parties: PartyOption[] }> {
    try {
        const rows = (await repository.getInvoiceParties()).map(toPartyOption);
        return { parties: rows };
    } catch (e) {
        console.error('[InvoicesPage] Failed to load parties:', e);
        return { parties: [] };
    }
}

/**
 * Only the party directory is loaded here. Rows come from the paged SQL list
 * query in the table, the drawer reads one invoice by id, and analytics fetches
 * its own dataset, so no view pays for a full table scan up front.
 */
const loadData = async () => queryDatabase((repositories) => loadParties(repositories.invoices));

export const load = (event: ModuleLoadEvent) => {
    event.depends('app:invoices');
    return deferPage(event, { parties: [] } as Awaited<ReturnType<typeof loadData>>, () => loadData());
};
