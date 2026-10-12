/** One received invoice sent to the expense-type decision: data only, the Worker owns the question. */
export interface InvoiceExpenseTypeItem {
    id: string;
    supplier: string;
    description: string;
    /** At most {@link MAX_LINE_DESCRIPTIONS} line item descriptions. */
    lines: string[];
}

export const MAX_LINE_DESCRIPTIONS = 10;
