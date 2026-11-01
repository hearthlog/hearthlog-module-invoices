<script lang="ts">
    import { appClock } from "@hearthlog/sdk/runtime";
    import { differenceInCalendarDays, parseISO } from "date-fns";
    import IconCheck from "~icons/mdi/check";
    import { formatInvoiceAmount, formatInvoiceDate } from "../../invoices/format.js";

    /**
     * The payable amount and where the invoice stands: issued, tax point, due,
     * paid. Every step comes from a date the invoice already stores; "paid" is
     * a status, so it carries no date.
     */
    let {
        total,
        vatTotal,
        issueDate,
        dueDate,
        taxPointDate,
        status,
    }: {
        total: number;
        vatTotal: number;
        issueDate: string;
        dueDate: string;
        taxPointDate?: string | null;
        status: string;
    } = $props();

    const day = (value: string | null | undefined) => (value ? parseISO(value.slice(0, 10)) : null);
    const daysFromNow = (value: string | null | undefined): number | null => {
        const date = day(value);
        return date && !Number.isNaN(date.getTime()) ? differenceInCalendarDays(date, appClock.now()) : null;
    };

    const steps = $derived.by(() => {
        const paid = status === "paid";
        const dueDays = daysFromNow(dueDate);
        const taxDays = daysFromNow(taxPointDate);
        const list: Array<{ label: string; note: string; state: "done" | "next" | "todo"; late?: boolean }> = [
            { label: "Issued", note: formatInvoiceDate(issueDate), state: "done" },
        ];
        if (taxPointDate) {
            list.push({ label: "Tax point", note: formatInvoiceDate(taxPointDate), state: taxDays !== null && taxDays > 0 ? "todo" : "done" });
        }
        const late = !paid && dueDays !== null && dueDays < 0;
        const when = dueDays === null ? "" : dueDays === 0 ? " · today" : dueDays > 0 ? ` · in ${dueDays} ${dueDays === 1 ? "day" : "days"}` : ` · ${-dueDays} ${dueDays === -1 ? "day" : "days"} late`;
        list.push({ label: "Due", note: `${formatInvoiceDate(dueDate)}${paid ? "" : when}`, state: paid ? "done" : "next", late });
        list.push({ label: "Paid", note: paid ? "Settled" : "Not yet", state: paid ? "done" : "todo" });
        return list;
    });
    const doneCount = $derived(steps.filter((step) => step.state === "done").length);
    const fillPercent = $derived(steps.length > 1 ? (Math.max(doneCount - 1, 0) / (steps.length - 1)) * 100 : 0);
</script>

<section class="flex flex-col gap-6" aria-label="Invoice summary">
    <div class="flex flex-col gap-1">
        <span class="stor-overline">Payable</span>
        <span class="text-[44px] font-semibold leading-[48px] tracking-[-0.03em] tabular-nums text-[var(--stor-ink)]">{formatInvoiceAmount(total)}</span>
        <span class="text-sm text-[var(--stor-muted-text)]">{formatInvoiceAmount(total - vatTotal)} before VAT · {formatInvoiceAmount(vatTotal)} VAT</span>
    </div>

    <ol class="relative grid pt-1" style:grid-template-columns={`repeat(${steps.length}, minmax(0, 1fr))`} aria-label="Where this invoice stands">
        <span class="absolute left-3 top-[19px] h-0.5 rounded bg-[var(--stor-surface-well,var(--stor-surface-muted))]" style:right={`calc(${100 / steps.length}% - 0.75rem)`} aria-hidden="true"></span>
        <span class="absolute left-3 top-[19px] h-0.5 rounded bg-[var(--stor-accent-strong)]" style:width={`calc((100% - ${100 / steps.length}%) * ${fillPercent / 100})`} aria-hidden="true"></span>
        {#each steps as step (step.label)}
            <li class="relative flex flex-col gap-0.5 pr-2" aria-current={step.state === "next" ? "step" : undefined}>
                <span
                    class="mb-2 grid h-6 w-6 place-items-center rounded-full {step.state === 'done'
                        ? 'bg-[var(--stor-accent-strong)] text-white'
                        : step.state === 'next'
                          ? 'bg-[var(--stor-surface)] shadow-[inset_0_0_0_2px_var(--stor-accent-strong)]'
                          : 'bg-[var(--stor-surface)] shadow-[inset_0_0_0_2px_var(--stor-border-strong)]'}"
                >
                    {#if step.state === "done"}<IconCheck class="h-3.5 w-3.5" />{/if}
                </span>
                <span class="text-[13px] font-semibold text-[var(--stor-ink)]">{step.label}</span>
                <span class="text-xs leading-4 {step.late ? 'font-semibold text-[var(--stor-negative)]' : 'text-[var(--stor-muted-text)]'}">{step.note}</span>
            </li>
        {/each}
    </ol>
</section>
