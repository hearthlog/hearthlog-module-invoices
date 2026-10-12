import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Wire format shared by the deterministic ISDOC mapper and, later, the LLM
 * provider adapter. Money and rates stay decimal strings so consumers can
 * validate them without floating-point damage before anything is stored;
 * dates are calendar dates (`YYYY-MM-DD`) or an empty string when absent.
 */
export const ExtractedItemSchema = Type.Object({
   description: Type.String(),
   /** Decimal string, e.g. `"2.5"`. */
   quantity: Type.String(),
   /** Net unit price as a decimal string. */
   unitPrice: Type.String(),
   /** VAT percentage as a decimal string, e.g. `"21"`. */
   vatRate: Type.String(),
   /** Document-declared line net amount, when the source provides it. */
   netAmount: Type.Optional(Type.String()),
   /** Document-declared line VAT amount, when the source provides it. */
   vatAmount: Type.Optional(Type.String()),
});

export const ExtractedInvoiceSchema = Type.Object({
   supplierName: Type.String(),
   supplierIco: Type.String(),
   supplierDic: Type.String(),
   supplierStreet: Type.String(),
   supplierCity: Type.String(),
   /** The party being billed; needed when the document is imported as an issued invoice. */
   customerName: Type.String(),
   customerIco: Type.String(),
   customerDic: Type.String(),
   customerStreet: Type.String(),
   customerCity: Type.String(),
   invoiceNumber: Type.String(),
   /** Gross payable total. */
   amount: Type.String(),
   /** Net total before VAT. */
   subtotal: Type.String(),
   vatTotal: Type.String(),
   currency: Type.String(),
   vatApplicable: Type.Union([Type.Boolean(), Type.Null()]),
   issueDate: Type.String(),
   dueDate: Type.String(),
   taxPointDate: Type.String(),
   bankAccount: Type.String(),
   variableSymbol: Type.String(),
   items: Type.Array(ExtractedItemSchema),
});

export type ExtractedInvoicePayload = Static<typeof ExtractedInvoiceSchema>;
export type ExtractedItemPayload = Static<typeof ExtractedItemSchema>;

/** Runtime guard for data crossing a trust boundary (LLM output, stored metadata). */
export function isExtractedInvoice(
   value: unknown,
): value is ExtractedInvoicePayload {
   return Value.Check(ExtractedInvoiceSchema, value);
}
