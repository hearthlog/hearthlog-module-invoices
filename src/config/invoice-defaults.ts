/**
 * Default invoice configuration.
 */

/**
 * Default VAT rate (21% in Czech Republic)
 */
export const DEFAULT_VAT_RATE = 21;

/**
 * Payment method sent to the document renderer for generated invoices.
 */
export const DEFAULT_PAYMENT_METHOD = "bank_transfer";

/**
 * Default payment term in days from the issue date, used to derive the due
 * date of a new invoice (and of legacy records without one).
 */
export const DEFAULT_PAYMENT_TERM_DAYS = 14;

/**
 * Registration footer pre-filled for a supplier that has none recorded.
 * Standard wording for a Czech sole trader in the trade register; the field
 * stays editable and a deliberately cleared value is kept empty.
 */
export const DEFAULT_SUPPLIER_REGISTRATION =
    "Fyzická osoba zapsaná v živnostenském rejstříku.";
