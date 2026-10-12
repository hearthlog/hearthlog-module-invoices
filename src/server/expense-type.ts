import { aiInput, AiRequestError, type AiCapabilityDefinition } from '@hearthlog/contracts';
import { EXPENSE_TYPES } from '../invoices/expense-types.js';
import { MAX_LINE_DESCRIPTIONS, type InvoiceExpenseTypeItem } from '../invoices/expense-type-item.js';

const MAX_NAME = 200;
const MAX_DESCRIPTION = 500;

/** Which expense type a received invoice is for, picked by a small decision model. */
export const invoiceExpenseType: AiCapabilityDefinition = {
    options: () => EXPENSE_TYPES.map((type) => ({ value: type.value, meaning: type.label })),
    parseItem(value): InvoiceExpenseTypeItem {
        const item = aiInput.object(value);
        const lines = item.lines === undefined ? [] : item.lines;
        if (!Array.isArray(lines) || lines.length > MAX_LINE_DESCRIPTIONS) throw new AiRequestError('Invalid line items');
        return {
            id: aiInput.id(item.id),
            supplier: aiInput.text(item.supplier, MAX_NAME),
            description: aiInput.text(item.description ?? '', MAX_DESCRIPTION, true),
            lines: lines.map((line) => aiInput.text(line, MAX_NAME, true)),
        };
    },
    question(item) {
        const invoice = item as InvoiceExpenseTypeItem;
        const lines = invoice.lines.map((line) => `- ${JSON.stringify(line)}`).join('\n');
        return {
            state: `Received invoice. Supplier: ${JSON.stringify(invoice.supplier)}. ` +
                `Description: ${JSON.stringify(invoice.description)}.` + (lines ? `\nLine items:\n${lines}` : ''),
            instructions: 'What type of expense is this invoice for? Answer none if it is unclear or no type fits.',
        };
    },
};
