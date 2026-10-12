import {
    emptyExtractedInvoice,
    type ExtractedInvoice,
    type ExtractionResult,
    type ExtractionWarning,
} from "./types.js";
import { normalizeDecimalString, parseDecimalString } from "./decimal.js";
import { missingFieldWarnings, totalWarnings } from "./validate.js";

/**
 * Deterministic ISDOC reader.
 *
 * The mapper is namespace-tolerant: elements are matched by local name so both
 * ISDOC 6.x (`http://isdoc.cz/namespace/2013`) and older 5.x documents parse
 * without version branching. Nothing is inferred: a missing element stays
 * empty and produces a warning instead of a guessed value.
 */

export interface IsdocParseOptions {
    /** Attachment file name, kept in metadata for diagnostics. */
    attachmentName?: string;
}

/** Standalone ISDOC files use the same size limit as the upload route. */
const MAX_ISDOC_FILE_BYTES = 5 * 1024 * 1024;

export type IsdocFileOutcome =
    | { kind: "found"; result: ExtractionResult; xml: string; name: string }
    | { kind: "invalid"; message: string };

/**
 * Reads a standalone `.isdoc`/`.xml` file chosen next to a PDF that has no
 * embedded ISDOC. The bytes are kept verbatim so the same XML can be stored as
 * the invoice's electronic document.
 */
export async function readIsdocFile(file: File): Promise<IsdocFileOutcome> {
    if (file.size < 1 || file.size > MAX_ISDOC_FILE_BYTES) {
        return {
            kind: "invalid",
            message: "The ISDOC file must be 5 MiB or smaller.",
        };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Reject binaries before decoding; an ISDOC file is UTF-8 XML text.
    const probe = bytes.subarray(0, 256);
    for (const byte of probe) {
        if (byte === 0)
            return { kind: "invalid", message: "Choose an ISDOC (XML) file." };
    }
    let xml: string;
    try {
        xml = new TextDecoder("utf-8").decode(bytes);
    } catch {
        return { kind: "invalid", message: "Choose an ISDOC (XML) file." };
    }
    const trimmed = xml.replace(/^\uFEFF/, "").trimStart();
    if (!trimmed.startsWith("<")) {
        return { kind: "invalid", message: "Choose an ISDOC (XML) file." };
    }
    const result = parseIsdocXml(xml, { attachmentName: file.name });
    if (result.warnings.some((warning) => warning.code === "invalid-isdoc")) {
        return {
            kind: "invalid",
            message: "The file is not an ISDOC invoice.",
        };
    }
    return { kind: "found", result, xml, name: file.name };
}

/** Parses raw ISDOC XML with the browser XML parser. */
export function parseIsdocXml(
    xml: string,
    options: IsdocParseOptions = {},
): ExtractionResult {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    return mapIsdocDocument(document, options);
}

/** Maps an already parsed XML document; separated so tests can run without a DOM. */
export function mapIsdocDocument(
    document: Document,
    options: IsdocParseOptions = {},
): ExtractionResult {
    const invoice = emptyExtractedInvoice();
    const warnings: ExtractionWarning[] = [];
    const root = document.documentElement;
    if (!root || root.localName !== "Invoice") {
        return {
            source: "isdoc",
            invoice,
            warnings: [
                {
                    code: "invalid-isdoc",
                    message: "The attached file is not an ISDOC invoice.",
                },
            ],
            metadata: {
                attachmentName: options.attachmentName ?? "",
                isdocVersion: "",
            },
        };
    }

    invoice.invoiceNumber = text(root, "ID");
    invoice.issueDate = calendarDate(text(root, "IssueDate"));
    invoice.taxPointDate = calendarDate(text(root, "TaxPointDate"));
    invoice.vatApplicable = booleanValue(text(root, "VATApplicable"));
    invoice.currency = text(root, "LocalCurrencyCode") || "CZK";

    mapSupplier(invoice, root);
    mapCustomer(invoice, root);
    const totals = mapTotals(invoice, root);
    mapPayment(invoice, root);
    mapLines(invoice, root, invoice.vatApplicable);

    warnings.push(...missingFieldWarnings(invoice));
    if (totals.zeroPayable) {
        warnings.push({
            code: "zero-payable",
            field: "amount",
            message: `The document states nothing left to pay; the invoice total ${invoice.amount} ${invoice.currency} is used instead.`,
        });
    }
    if (invoice.currency && invoice.currency.toUpperCase() !== "CZK") {
        warnings.push({
            code: "foreign-currency",
            field: "currency",
            message: `The invoice is in ${invoice.currency}; check the amount before saving.`,
        });
    }
    warnings.push(...totalWarnings(invoice));

    return {
        source: "isdoc",
        invoice,
        warnings,
        metadata: {
            attachmentName: options.attachmentName ?? "",
            isdocVersion: root.getAttribute("version") ?? "",
        },
    };
}

function mapSupplier(invoice: ExtractedInvoice, root: Element): void {
    const party = path(root, "AccountingSupplierParty", "Party");
    invoice.supplierName = text(path(party, "PartyName", "Name"));
    invoice.supplierIco = text(path(party, "PartyIdentification", "ID"));
    invoice.supplierDic = text(path(party, "PartyTaxScheme", "CompanyID"));
    const address = path(party, "PostalAddress");
    invoice.supplierStreet = joinParts(
        text(address, "StreetName"),
        text(address, "BuildingNumber"),
    );
    invoice.supplierCity = joinParts(
        text(address, "PostalZone"),
        text(address, "CityName"),
    );
}

/**
 * The billed party. Received-invoice review does not need it, but importing
 * the same document as an issued invoice does: there the customer is the
 * counterparty while the supplier is the importing company.
 */
function mapCustomer(invoice: ExtractedInvoice, root: Element): void {
    const party = path(root, "AccountingCustomerParty", "Party");
    invoice.customerName = text(path(party, "PartyName", "Name"));
    invoice.customerIco = text(path(party, "PartyIdentification", "ID"));
    invoice.customerDic = text(path(party, "PartyTaxScheme", "CompanyID"));
    const address = path(party, "PostalAddress");
    invoice.customerStreet = joinParts(
        text(address, "StreetName"),
        text(address, "BuildingNumber"),
    );
    invoice.customerCity = joinParts(
        text(address, "PostalZone"),
        text(address, "CityName"),
    );
}

function mapTotals(
    invoice: ExtractedInvoice,
    root: Element,
): { zeroPayable: boolean } {
    const monetary = path(root, "LegalMonetaryTotal");
    const inclusiveRaw = text(monetary, "TaxInclusiveAmount");
    invoice.subtotal = normalizeDecimalString(
        text(monetary, "TaxExclusiveAmount"),
    );
    invoice.vatTotal = normalizeDecimalString(
        text(directChild(root, "TaxTotal"), "TaxAmount"),
    );
    if (!invoice.vatTotal) {
        // Older documents sometimes omit TaxTotal/TaxAmount; derive only when
        // both inclusive and exclusive amounts are explicitly present.
        const inclusive = parseDecimalString(inclusiveRaw);
        const exclusive = parseDecimalString(invoice.subtotal);
        if (inclusive !== null && exclusive !== null) {
            invoice.vatTotal = (inclusive - exclusive).toFixed(2);
        }
    }
    // A zero payable amount means nothing is left to pay (usually already
    // settled); the invoice total is the useful value for tracking.
    const payable = parseDecimalString(text(monetary, "PayableAmount"));
    const inclusive = parseDecimalString(inclusiveRaw);
    if (payable === 0 && inclusive !== null && inclusive > 0) {
        invoice.amount = normalizeDecimalString(inclusiveRaw);
        return { zeroPayable: true };
    }
    invoice.amount = normalizeDecimalString(text(monetary, "PayableAmount"));
    return { zeroPayable: false };
}

function mapPayment(invoice: ExtractedInvoice, root: Element): void {
    const payment =
        path(root, "PaymentMeans", "Payment") ?? directChild(root, "Payment");
    const details = directChild(payment, "Details");
    const accountId = text(details, "ID");
    const bankCode = text(details, "BankCode");
    const iban = text(details, "IBAN");
    // Some documents put the full `number/bankCode` form into ID already.
    invoice.bankAccount = accountId.includes("/")
        ? accountId
        : accountId && bankCode
          ? `${accountId}/${bankCode}`
          : accountId || iban;
    invoice.variableSymbol = text(details, "VariableSymbol");
    invoice.dueDate = calendarDate(
        text(details, "PaymentDueDate") || text(payment, "PaymentDueDate"),
    );
}

function mapLines(
    invoice: ExtractedInvoice,
    root: Element,
    vatApplicable: boolean | null,
): void {
    const lines = directChild(root, "InvoiceLines");
    for (const line of children(lines, "InvoiceLine")) {
        const vatRate = text(path(line, "ClassifiedTaxCategory", "Percent"));
        const netAmount = text(line, "LineExtensionAmount");
        const vatAmount = text(line, "LineExtensionTaxAmount");
        invoice.items.push({
            description: text(line, "Item", "Description"),
            quantity: text(line, "InvoicedQuantity"),
            unitPrice: text(line, "UnitPrice"),
            // A document explicitly marked as non-VAT implies a zero rate when
            // the line carries no category; anything else stays unknown.
            vatRate: vatRate || (vatApplicable === false ? "0" : ""),
            // Declared line amounts are authoritative for validation.
            ...(netAmount
                ? { netAmount: normalizeDecimalString(netAmount) }
                : {}),
            ...(vatAmount
                ? { vatAmount: normalizeDecimalString(vatAmount) }
                : {}),
        });
    }
}

function calendarDate(value: string): string {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    return match?.[1] ?? "";
}

function booleanValue(value: string): boolean | null {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
    return null;
}

function joinParts(...parts: string[]): string {
    return parts.filter(Boolean).join(" ");
}

/** Direct child matching a local name (namespace-agnostic). */
function directChild(
    parent: Element | null,
    localName: string,
): Element | null {
    if (!parent) return null;
    for (const child of elementChildren(parent)) {
        if (child.localName === localName) return child;
    }
    return null;
}

/** All direct children matching a local name. */
function children(parent: Element | null, localName: string): Element[] {
    if (!parent) return [];
    return elementChildren(parent).filter(
        (child) => child.localName === localName,
    );
}

/** Follows a chain of direct children, e.g. `Item/Description`. */
function path(root: Element | null, ...names: string[]): Element | null {
    let current: Element | null = root;
    for (const name of names) {
        current = directChild(current, name);
        if (!current) return null;
    }
    return current;
}

/** Trimmed text content, or an empty string when the element is absent. */
function text(parent: Element | null, ...names: string[]): string {
    const element = names.length > 0 ? path(parent, ...names) : parent;
    return element?.textContent?.trim() ?? "";
}

function elementChildren(parent: Element): Element[] {
    const result: Element[] = [];
    for (let index = 0; index < parent.childNodes.length; index += 1) {
        const node = parent.childNodes.item(index);
        if (node.nodeType === 1) result.push(node as Element);
    }
    return result;
}
