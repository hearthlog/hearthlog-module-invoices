<script lang="ts">
    import { queryDatabase } from "@hearthlog/sdk/data";
    import { EXPENSE_TYPES, expenseTypeLabel } from "../../invoices/expense-types.js";
    import { expenseTypeHistoryReason, suggestExpenseTypes } from "../../invoices/expense-type-suggestions.js";
    import { EXPENSE_TYPE_UNSET } from "../../invoices/list-contracts.js";
    import { formatMoney } from "@hearthlog/sdk/format";
    import { DecisionReviewSheet, type ReviewItem } from "@hearthlog/sdk/ui";
    import type { SelectOption } from "@hearthlog/sdk/ui";
    import { format, parseISO } from "date-fns";

    /** One invoice's new expense type; the earlier value is always empty. */
    export interface ExpenseTypeChange {
        id: string;
        expenseType: string;
    }

    let {
        show,
        onClose,
        onApply,
    }: {
        show: boolean;
        onClose: () => void;
        /** Writes every change in one action. Throws when saving fails. */
        onApply: (changes: ExpenseTypeChange[]) => Promise<void>;
    } = $props();

    // `unset` stands for "no type" so the picker can show Choose; it is never written.
    const options: SelectOption[] = [
        { value: EXPENSE_TYPE_UNSET, label: "Choose" },
        ...EXPENSE_TYPES.map(({ value, label }) => ({ value, label })),
    ];

    async function load(): Promise<ReviewItem[]> {
        const rows = await queryDatabase((repositories) => repositories.invoices.getReceivedWithoutExpenseType());
        const suggestions = await suggestExpenseTypes(rows.map((row) => ({
            id: row.id,
            supplierName: row.supplierName,
            supplierIco: row.supplierIco,
            description: row.description,
            lines: row.lines,
        })));
        return rows.map((row) => {
            const found = suggestions.get(row.id);
            return {
                row: {
                    id: row.id,
                    title: row.supplierName || "Supplier needed",
                    meta: [
                        row.invoiceNumber || "No number",
                        row.issueDate ? format(parseISO(row.issueDate), "d MMM yyyy") : "",
                        row.amount > 0 ? formatMoney(row.amount, { currency: row.currency }) : "",
                    ].filter(Boolean).join(" · "),
                },
                previous: { value: EXPENSE_TYPE_UNSET, source: "" },
                suggestion: found ? {
                    value: found.expenseType,
                    label: expenseTypeLabel(found.expenseType),
                    kind: found.origin.kind,
                    reason: found.origin.kind === "history" ? expenseTypeHistoryReason(found.origin.via) : "",
                    band: found.origin.kind === "ai" ? found.origin.band : "apply",
                    source: found.origin.kind === "history" ? "history" : `ai:${found.origin.model}`,
                } : null,
            };
        });
    }
</script>

<DecisionReviewSheet
    {show}
    title="Type invoices"
    description="Received invoices without an expense type"
    fieldLabel="Expense type"
    {options}
    unsetValue={EXPENSE_TYPE_UNSET}
    emptyText="Every received invoice has an expense type."
    loadingLabel="Finding expense types"
    applyTestId="apply-expense-types"
    loadKey="received"
    {load}
    {onClose}
    onApply={(changes) => onApply(changes.map((change) => ({ id: change.id, expenseType: change.value })))}
/>
