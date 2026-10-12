/**
 * VAT and income-tax filing assumptions for the analytics dashboard.
 *
 * Deliberately a code constant next to `taxConfig`: the app knows the tenant
 * keeps CZK books but not whether it files VAT quarterly or monthly, so the
 * deadline is configurable and always presented as a hint, never as advice.
 * A per-tenant override can be layered on later without moving the UI.
 */
export interface VatConfig {
    /** Filing period for VAT returns. */
    period: "quarter" | "month";
    /** Day of the month the return is due (the statutory Czech day is 25). */
    dueDayOfMonth: number;
    /** The electronic income-tax deadline inside the year after the tax year. */
    incomeTaxDeadline: { month: number; day: number };
}

export const vatConfig: VatConfig = {
    period: "quarter",
    dueDayOfMonth: 25,
    incomeTaxDeadline: { month: 5, day: 2 },
};

/** `YYYY-MM-DD`, clamped to the last day of the target month. */
function deadlineDay(year: number, monthIndex: number, day: number): string {
    const first = new Date(Date.UTC(year, monthIndex, 1));
    const lastDay = new Date(
        Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
    first.setUTCDate(Math.min(day, lastDay));
    return first.toISOString().slice(0, 10);
}

function localDay(now: Date): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/**
 * The first VAT filing deadline on or after `now` as an ISO day.
 *
 * A quarterly return for a period ending in March is due the next month, so
 * the candidates are the 25th of the month following every quarter end (or
 * every month for a monthly payer). Three years around `now` are generated so
 * the window always contains a future candidate.
 */
export function nextVatDeadline(
    now: Date,
    config: VatConfig = vatConfig,
): string {
    const today = localDay(now);
    const year = now.getFullYear();
    const candidates: string[] = [];
    for (let candidate = year - 1; candidate <= year + 1; candidate += 1) {
        if (config.period === "quarter") {
            for (const quarterEnd of [3, 6, 9, 12]) {
                // Month index equals the 1-based quarter-end month, which is
                // exactly the following month (December rolls into January).
                candidates.push(
                    deadlineDay(candidate, quarterEnd, config.dueDayOfMonth),
                );
            }
        } else {
            for (let month = 1; month <= 12; month += 1) {
                candidates.push(
                    deadlineDay(candidate, month, config.dueDayOfMonth),
                );
            }
        }
    }
    return candidates
        .filter((day) => day >= today)
        .sort((left, right) => left.localeCompare(right))[0]!;
}

/** The income-tax filing deadline for a tax year as an ISO day. */
export function nextIncomeTaxDeadline(
    taxYear: number,
    config: VatConfig = vatConfig,
): string {
    return deadlineDay(
        taxYear + 1,
        config.incomeTaxDeadline.month - 1,
        config.incomeTaxDeadline.day,
    );
}
