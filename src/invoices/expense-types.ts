/** The expense types of received invoices, in the order forms list them. The value `''` means not set. */
export const EXPENSE_TYPES = [
    { value: 'services', label: 'Services' },
    { value: 'goods', label: 'Goods and materials' },
    { value: 'software', label: 'Software and subscriptions' },
    { value: 'equipment', label: 'Equipment' },
    { value: 'telecom', label: 'Telecom and internet' },
    { value: 'rent-energy', label: 'Rent and energy' },
    { value: 'travel', label: 'Travel' },
    { value: 'marketing', label: 'Marketing' },
    { value: 'education', label: 'Education' },
    { value: 'insurance', label: 'Insurance' },
    { value: 'taxes-fees', label: 'Taxes and fees' },
    { value: 'other', label: 'Other' },
] as const;

export type ExpenseType = (typeof EXPENSE_TYPES)[number]['value'];

const LABELS: Record<string, string> = Object.fromEntries(
    EXPENSE_TYPES.map((type) => [type.value, type.label]),
);

/** The label of a stored type, or an empty string when none is set. */
export function expenseTypeLabel(value: string | null | undefined): string {
    return LABELS[value ?? ''] ?? '';
}

export function isExpenseType(value: unknown): value is ExpenseType {
    return typeof value === 'string' && value in LABELS;
}
