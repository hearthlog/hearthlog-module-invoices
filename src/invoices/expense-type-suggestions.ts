import { requestDecisions } from '@hearthlog/sdk/ai';
import { suggestionBand } from '@hearthlog/sdk/ai';
import { MAX_LINE_DESCRIPTIONS, type InvoiceExpenseTypeItem } from './expense-type-item.js';
import { queryDatabase } from '@hearthlog/sdk/data';
import { isExpenseType } from './expense-types.js';

/**
 * Suggests an expense type for received invoices that have none. The history
 * rule runs first, in SQL, with no model: the type last used for the same
 * supplier. The rest go to the decision API with the supplier name, the
 * description and up to 10 line item descriptions; the PDF, bank details and
 * amounts are never sent. A suggestion is never saved here.
 */

export interface ExpenseTypeInput {
    id: string;
    supplierName: string;
    supplierIco: string;
    description: string;
    lines: string[];
}

export type ExpenseTypeOrigin =
    | { kind: 'history'; via: 'ico' | 'name' }
    | { kind: 'ai'; model: string; probability: number; band: 'apply' | 'offer' };

export interface ExpenseTypeSuggestion {
    id: string;
    expenseType: string;
    origin: ExpenseTypeOrigin;
}

/** The plain reason shown next to a history match. */
export function expenseTypeHistoryReason(via: 'ico' | 'name'): string {
    return via === 'ico' ? 'Same supplier as before' : 'Same supplier name as before';
}

export async function suggestExpenseTypes(rows: ExpenseTypeInput[]): Promise<Map<string, ExpenseTypeSuggestion>> {
    return (await suggestExpenseTypesDetailed(rows)).suggestions;
}

/** Like {@link suggestExpenseTypes}, and says whether the model could not be asked, so a button can explain an empty result. */
export async function suggestExpenseTypesDetailed(
    rows: ExpenseTypeInput[],
): Promise<{ suggestions: Map<string, ExpenseTypeSuggestion>; aiUnavailable: boolean }> {
    const suggestions = new Map<string, ExpenseTypeSuggestion>();
    if (rows.length === 0) return { suggestions, aiUnavailable: false };

    const history = await queryDatabase((repositories) => repositories.invoices.expenseTypeFromHistory(
        rows.map((row) => ({ id: row.id, supplierIco: row.supplierIco, supplierName: row.supplierName })),
    )).catch(() => []);
    for (const hit of history) {
        if (isExpenseType(hit.expenseType)) {
            suggestions.set(hit.id, { id: hit.id, expenseType: hit.expenseType, origin: { kind: 'history', via: hit.via } });
        }
    }

    const items: InvoiceExpenseTypeItem[] = rows
        .filter((row) => !suggestions.has(row.id) && row.supplierName.trim() !== '')
        .map((row) => ({
            id: row.id,
            supplier: row.supplierName.trim().slice(0, 200),
            description: row.description.trim().slice(0, 500),
            lines: row.lines.map((line) => line.trim()).filter((line) => line !== '').slice(0, MAX_LINE_DESCRIPTIONS)
                .map((line) => line.slice(0, 200)),
        }));
    if (items.length === 0) return { suggestions, aiUnavailable: false };
    const answered = await requestDecisions('invoice-expense-type', items);
    for (const decision of answered.decisions) {
        const band = suggestionBand(decision.option, decision.probability);
        if (band === 'choose' || !isExpenseType(decision.option)) continue;
        suggestions.set(decision.id, {
            id: decision.id,
            expenseType: decision.option,
            origin: { kind: 'ai', model: answered.model, probability: decision.probability, band },
        });
    }
    return { suggestions, aiUnavailable: !answered.answered };
}
