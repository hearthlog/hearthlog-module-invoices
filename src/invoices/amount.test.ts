import { describe, expect, it } from "vitest";
import { invoiceTotalPayable } from "./amount.js";

describe("invoiceTotalPayable", () => {
    it("uses the same VAT-inclusive total shown in invoice details", () => {
        expect(invoiceTotalPayable({
            amount: 1000,
            items: JSON.stringify([
                { quantity: 2, unitPrice: 400, vatRate: 21 },
                { quantity: 1, unitPrice: 200, vatRate: 12 },
            ]),
        })).toBe(1192);
    });

    it("uses the stored amount when line items are unavailable", () => {
        expect(invoiceTotalPayable({ amount: 125, items: "invalid" })).toBe(125);
    });
});
