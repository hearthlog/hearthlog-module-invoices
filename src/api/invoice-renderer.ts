/**
 * Invoice document generation client.
 *
 * Requests go to the frontend Worker's same-origin gateway
 * (`worker/invoice-renderer.ts`), which attaches the renderer bearer
 * credential. The browser never talks to the renderer directly: it requires
 * authentication and does not answer CORS preflights.
 */

import { DEFAULT_PAYMENT_METHOD } from "../config/invoice-defaults.js";

export const INVOICE_RENDERER_BASE_PATH = "/api/invoice-generation";

import {
    invoiceDocumentState, isDocumentUuid, parsePostalAddress, resolveInvoiceParty,
    type PostalAddress, type InvoiceDocumentSource, type InvoicePartySource,
} from "../invoices/document.js";
export type { InvoicePartySource } from "../invoices/document.js";

const DEFAULT_TIME_ZONE = "Europe/Prague";
const RENDERER_TIMEOUT_MS = 60_000;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SQLITE_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

const RENDERABLE_STATUSES = new Set(["draft", "sent", "paid", "overdue"]);
export type InvoiceRenderStatus = "draft" | "sent" | "paid" | "overdue";
export type InvoicePartyRole = "supplier" | "customer";
export type InvoiceGenerationLocale = "cs-CZ" | "en-GB";
export type InvoicePaymentMethod = "bank_transfer" | "cash" | "card";

export interface InvoicePartySnapshot {
    id: string;
    name: string;
    street: string;
    city: string;
    ico: string;
    dic: string | null;
    bankAccount: string | null;
    partyType: InvoicePartyRole;
    registration?: string;
    postalAddress?: PostalAddress;
}

export interface InvoiceLineItemSnapshot {
    description: string;
    quantity: string;
    unitPrice: string;
    vatRate: number;
}

export interface InvoiceBankAccountSnapshot {
    accountNumber: string;
    bankCode: string;
    bankName?: string;
    iban?: string;
    bic?: string;
}

export interface InvoicePaymentSnapshot {
    method: InvoicePaymentMethod;
    variableSymbol?: string;
    constantSymbol?: string;
    specificSymbol?: string;
    qrMaskPattern?: number;
    bankAccount?: InvoiceBankAccountSnapshot;
}

export interface InvoiceDocumentSnapshot {
    id: string;
    invoiceNumber: string;
    status: InvoiceRenderStatus;
    documentState?: "draft" | "issued";
    documentUuid?: string;
    vatApplicable?: boolean;
    electronicAgreementReference?: string;
    description: string | null;
    /** Calendar date in `source.timezone` (or Europe/Prague by default). */
    issueDate: string;
    dueDate: string | null;
    /** Tax point date (DUZP); falls back to the issue date for PDF output. */
    taxPointDate?: string;
    currency: "CZK";
    amount?: string;
    supplierId: string | null;
    customerId: string | null;
    supplier: InvoicePartySnapshot | null;
    customer: InvoicePartySnapshot | null;
    items: InvoiceLineItemSnapshot[];
    payment?: InvoicePaymentSnapshot;
    isOverdue?: boolean;
}

export interface InvoiceGenerationRequest {
    invoice: InvoiceDocumentSnapshot;
    locale?: InvoiceGenerationLocale;
    requireIsdoc?: boolean;
}

/** Stored invoice shape (a subset of the read-model type). */
export interface InvoiceSource extends InvoiceDocumentSource {
    id: string;
    invoice_number: string;
    amount: number;
    supplier_id: string | null;
    customer_id: string | null;
    description: string | null;
    issue_date: string;
    due_date: string | null;
    tax_point_date: string | null;
    status: string;
    items: string;
}

export interface BuildInvoiceRequestOptions {
    suppliers: readonly InvoicePartySource[];
    customers: readonly InvoicePartySource[];
    /** Page-derived badge state at the selected view clock. */
    isOverdue?: boolean;
    timeZone?: string;
    locale?: InvoiceGenerationLocale;
    /** Defaults to `bank_transfer`; the renderer's payment method enum. */
    paymentMethod?: InvoicePaymentMethod;
}

export class InvoiceRendererError extends Error {
    readonly status: number;

    constructor(message: string, status = 0) {
        super(message);
        this.name = "InvoiceRendererError";
        this.status = status;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Render a nonnegative number as the contract's plain base-10 decimal string.
 * `Number.toString()` only falls back to exponent notation outside the ranges
 * real invoices use; expand it rather than sending an invalid value.
 */
function toDecimalString(
    value: number,
    field: string,
    options: { positive?: boolean } = {},
): string {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (options.positive === true && value === 0)
    ) {
        throw new InvoiceRendererError(
            `The invoice has an invalid ${field}. Edit the invoice before downloading the PDF.`,
            422,
        );
    }
    let text = value.toString();
    if (!DECIMAL_PATTERN.test(text)) {
        text = value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
    }
    if (!DECIMAL_PATTERN.test(text)) {
        throw new InvoiceRendererError(
            `The invoice ${field} is outside the supported range.`,
            422,
        );
    }
    return text;
}

function parseStoredItems(itemsJson: string): Record<string, unknown>[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(itemsJson);
    } catch {
        throw new InvoiceRendererError(
            "The invoice line items are not valid JSON. Edit the invoice before downloading the PDF.",
            422,
        );
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new InvoiceRendererError(
            "The invoice has no line items. Add at least one line item before downloading the PDF.",
            422,
        );
    }
    return parsed.map((item) => {
        if (!isRecord(item)) {
            throw new InvoiceRendererError(
                "The invoice has an invalid line item. Edit the invoice before downloading the PDF.",
                422,
            );
        }
        return item;
    });
}

function mapLineItems(itemsJson: string): InvoiceLineItemSnapshot[] {
    return parseStoredItems(itemsJson).map((item, index) => {
        const rawVatRate =
            item.vatRate === undefined || item.vatRate === null
                ? 0
                : Number(item.vatRate);
        if (!Number.isFinite(rawVatRate) || rawVatRate < 0 || rawVatRate > 100) {
            throw new InvoiceRendererError(
                `Line ${index + 1} has an invalid VAT rate. Edit the invoice before downloading the PDF.`,
                422,
            );
        }
        return {
            description:
                typeof item.description === "string" ? item.description : "",
            quantity: toDecimalString(Number(item.quantity), "line quantity", {
                positive: true,
            }),
            unitPrice: toDecimalString(Number(item.unitPrice), "line unit price"),
            vatRate: rawVatRate,
        };
    });
}

/**
 * Convert a stored timestamp to a calendar date in the application timezone.
 * SQLite `datetime('now')` values are UTC without a timezone marker; the page's
 * own writes use ISO strings. A naive UTC slice would shift dates near
 * midnight, so format through the requested timezone instead.
 */
function toCalendarDate(
    value: string | null | undefined,
    timeZone: string,
    label: string,
): string | null {
    if (value === null || value === undefined || value.trim() === "") {
        return null;
    }
    const text = value.trim();
    if (CALENDAR_DATE_PATTERN.test(text)) {
        return text;
    }
    const normalized = SQLITE_DATETIME_PATTERN.test(text)
        ? `${text.replace(" ", "T")}Z`
        : text;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
        throw new InvoiceRendererError(
            `The invoice ${label} is invalid. Edit the invoice before downloading the PDF.`,
            422,
        );
    }
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((entry) => entry.type === type)?.value ?? "";
    const calendarDate = `${part("year")}-${part("month")}-${part("day")}`;
    if (!CALENDAR_DATE_PATTERN.test(calendarDate)) {
        throw new InvoiceRendererError(
            `The invoice ${label} is invalid. Edit the invoice before downloading the PDF.`,
            422,
        );
    }
    return calendarDate;
}

function renderStatus(status: string): InvoiceRenderStatus {
    if (RENDERABLE_STATUSES.has(status)) {
        return status as InvoiceRenderStatus;
    }
    throw new InvoiceRendererError(
        `Invoice status "${status}" cannot be rendered.`,
        422,
    );
}

function mapParty(
    party: InvoicePartySource | undefined,
    role: InvoicePartyRole,
): InvoicePartySnapshot | null {
    if (!party) return null;
    return {
        id: party.id,
        name: party.name,
        street: party.street ?? "",
        city: party.city ?? "",
        ico: party.ico ?? "",
        dic: party.dic ?? null,
        bankAccount: party.bank_account ?? null,
        partyType: role,
        ...(party.registration ? { registration: party.registration } : {}),
        ...(party.postal_address ? { postalAddress: parsePostalAddress(party.postal_address) } : {}),
    };
}

/**
 * Derive the payment variable symbol from the invoice number. The renderer
 * accepts 1-10 digits, so separators, letters and other characters are removed
 * rather than rejected. When the number has no digits at all, the issue date
 * supplies a stable fallback so repeated downloads do not change the symbol.
 */
export function generateVariableSymbol(
    invoiceNumber: string,
    issueDate: string,
): string {
    const digits = invoiceNumber.replace(/\D/g, "");
    if (digits) return digits.slice(0, 10);
    const fallback = issueDate.replace(/\D/g, "").slice(0, 10);
    return fallback || "1";
}

const BANK_ACCOUNT_PATTERN =
    /^((?:[0-9]{1,6}-)?[0-9]{1,10})\/([0-9]{4})$/;

/**
 * Split the stored display account (`[prefix-]number/bankCode`) into the
 * renderer's structured beneficiary account. The payment QR is only generated
 * when this structure is present, so callers send the display string without
 * it when the format is not recognized.
 */
export function parseBankAccount(
    value: string | null | undefined,
): InvoiceBankAccountSnapshot | null {
    const normalized = value?.replace(/\s+/g, "") ?? "";
    const match = BANK_ACCOUNT_PATTERN.exec(normalized);
    if (!match?.[1] || !match[2]) return null;
    return { accountNumber: match[1], bankCode: match[2] };
}

/**
 * Facts the ISDOC profile requires that the snapshot does not have. An empty
 * list means the document can be rendered as ISDOC. Callers keep rendering the
 * PDF when the list is non-empty, but must not demand the attachment, so a
 * workflow change or legacy record can never block the PDF.
 */
export function isdocDocumentGaps(
    document: InvoiceDocumentSnapshot,
): string[] {
    const gaps: string[] = [];
    if (!document.documentUuid) gaps.push("the document UUID");
    if (document.vatApplicable === undefined) gaps.push("VAT applicability");
    if (document.vatApplicable === true && !document.taxPointDate) {
        gaps.push("the tax point date (DUZP)");
    }
    if (!document.dueDate) gaps.push("the due date");
    if (!document.supplier) gaps.push("the supplier");
    else if (!document.supplier.postalAddress) {
        gaps.push("the supplier's electronic invoice address");
    }
    if (!document.customer) gaps.push("the customer");
    else if (!document.customer.postalAddress) {
        gaps.push("the customer's electronic invoice address");
    }
    if (!document.payment) gaps.push("payment instructions");
    else {
        if (document.payment.method !== "bank_transfer") {
            gaps.push("a bank-transfer payment method");
        }
        if (!document.payment.bankAccount) {
            gaps.push("the supplier's bank account");
        }
    }
    if (
        document.vatApplicable === false &&
        document.items.some((item) => item.vatRate !== 0)
    ) {
        gaps.push("zero VAT rates on all lines for a non-VAT invoice");
    }
    return gaps;
}

/**
 * Build the renderer snapshot from one stored invoice and its resolved
 * parties. Throws `InvoiceRendererError` when the stored data cannot produce
 * a valid document, instead of silently generating an empty one.
 */
export function buildInvoiceGenerationRequest(
    invoice: InvoiceSource,
    options: BuildInvoiceRequestOptions,
): InvoiceGenerationRequest {
    if (!invoice.invoice_number.trim()) {
        throw new InvoiceRendererError(
            "The invoice number is missing. Edit the invoice before downloading the PDF.",
            422,
        );
    }

    const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    const issueDate = toCalendarDate(
        invoice.issue_date,
        timeZone,
        "issue date",
    );
    if (!issueDate) {
        throw new InvoiceRendererError(
            "The invoice issue date is missing. Edit the invoice before downloading the PDF.",
            422,
        );
    }

    const supplier = mapParty(
        resolveInvoiceParty(invoice, options.suppliers, "supplier"),
        "supplier",
    );
    const paymentMethod = options.paymentMethod ?? DEFAULT_PAYMENT_METHOD;
    // The renderer generates the payment QR only when it receives the
    // structured beneficiary account, so parse the supplier's display value
    // for bank transfers and omit it when the format is unknown.
    const paymentBankAccount =
        paymentMethod === "bank_transfer"
            ? parseBankAccount(supplier?.bankAccount)
            : null;

    const document: InvoiceDocumentSnapshot = {
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
        status: renderStatus(invoice.status),
        documentState: invoiceDocumentState(invoice),
        description: invoice.description ?? null,
        issueDate,
        dueDate: toCalendarDate(invoice.due_date, timeZone, "due date"),
        // Older invoices have no stored DUZP; the issue date is the ordinary
        // invoice default, keeps the PDF column populated and lets an issued
        // document carry ISDOC. Recording the true tax point date overrides it.
        taxPointDate:
            toCalendarDate(
                invoice.tax_point_date,
                timeZone,
                "tax point date",
            ) ?? issueDate,
        currency: "CZK",
        supplierId: invoice.supplier_id ?? null,
        customerId: invoice.customer_id ?? null,
        supplier,
        customer: mapParty(
            resolveInvoiceParty(invoice, options.customers, "customer"),
            "customer",
        ),
        items: mapLineItems(invoice.items),
        payment: {
            method: paymentMethod,
            variableSymbol: generateVariableSymbol(
                invoice.invoice_number,
                issueDate,
            ),
            ...(paymentBankAccount
                ? { bankAccount: paymentBankAccount }
                : {}),
        },
    };

    const documentUuid = invoice.document_uuid || (isDocumentUuid(invoice.id) ? invoice.id : undefined);
    if (documentUuid) {
        if (!isDocumentUuid(documentUuid)) throw new InvoiceRendererError("The document UUID is invalid. Edit the invoice before exporting it.", 422);
        document.documentUuid = documentUuid;
    }
    if (invoice.vat_applicable !== null && invoice.vat_applicable !== undefined) {
        if (![true, false, 0, 1].includes(invoice.vat_applicable)) throw new InvoiceRendererError("The invoice VAT applicability is invalid.", 422);
        document.vatApplicable = Boolean(invoice.vat_applicable);
    }
    // ISDOC requires the element; empty is allowed and asserts nothing.
    document.electronicAgreementReference = invoice.electronic_agreement_reference ?? "";
    if (invoice.payment_snapshot) {
        let payment: unknown;
        try {
            payment = JSON.parse(invoice.payment_snapshot);
        } catch {
            throw new InvoiceRendererError("The saved payment details are invalid.", 422);
        }
        if (!isRecord(payment) || !["bank_transfer", "cash", "card"].includes(String(payment.method))) throw new InvoiceRendererError("The saved payment details are invalid.", 422);
        // SAFETY: isRecord narrowed the value and `method` was checked against
        // the renderer's enum above; the renderer owns the remaining optional
        // payment fields and rejects anything it cannot render.
        document.payment = payment as unknown as InvoicePaymentSnapshot;
    }

    // `amount` is preserved list metadata, not a payable total. Omit it when
    // it cannot be represented as the contract's nonnegative decimal string.
    if (Number.isFinite(invoice.amount) && invoice.amount > 0) {
        document.amount = toDecimalString(invoice.amount, "amount");
    }
    if (options.isOverdue !== undefined) {
        document.isOverdue = options.isOverdue;
    }

    return {
        invoice: document,
        locale: options.locale ?? "cs-CZ",
        // Only assert ISDOC for an issued document that actually carries the
        // full profile. An incomplete issued document still renders as a
        // PDF; the UI names the missing facts instead of failing the export,
        // so marking an invoice sent/paid can never block PDF generation.
        requireIsdoc:
            document.documentState === "issued" &&
            isdocDocumentGaps(document).length === 0,
    };
}

/** Extract a download filename from a Content-Disposition header. */
export function filenameFromContentDisposition(
    header: string | null,
): string | null {
    if (!header) return null;
    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (encoded?.[1]) {
        try {
            return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ""));
        } catch {
            // Fall through to the plain filename parameter.
        }
    }
    const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header);
    if (quoted?.[1]) return quoted[1];
    const bare = /filename\s*=\s*([^;]+)/i.exec(header);
    return bare?.[1]?.trim() || null;
}

/** Keep a server-provided filename inside the download directory. */
export function sanitizeDownloadFilename(value: string): string {
    const base = value.split(/[\\/]/).pop() ?? "";
    const cleaned = base
        .replace(/[:*?"<>|\u0000-\u001f]/g, "-")
        .replace(/^\.+/, "")
        .trim();
    return cleaned.length > 0 ? cleaned : "invoice.pdf";
}

async function readProblemMessage(response: Response): Promise<string> {
    try {
        const value: unknown = await response.json();
        if (isRecord(value)) {
            const title =
                typeof value.title === "string" ? value.title : undefined;
            const detail =
                typeof value.detail === "string" ? value.detail : undefined;
            const error =
                typeof value.error === "string" ? value.error : undefined;
            const extra = Array.isArray(value.errors)
                ? value.errors
                      .map((entry) =>
                          isRecord(entry) && typeof entry.message === "string"
                              ? entry.message
                              : null,
                      )
                      .filter((entry): entry is string => Boolean(entry))
                      .slice(0, 3)
                      .join("; ")
                : "";
            const base =
                detail ??
                title ??
                error ??
                `The invoice renderer returned HTTP ${response.status}.`;
            return extra && !base.includes(extra) ? `${base} (${extra})` : base;
        }
    } catch {
        // Keep the status-based message when the problem body is unavailable.
    }
    return `The invoice renderer returned HTTP ${response.status}.`;
}

/**
 * Request a PDF from the renderer and return the raw blob. Callers that run in
 * the browser should prefer `downloadInvoicePdf`.
 */
export async function requestInvoicePdf(
    request: InvoiceGenerationRequest,
    options: { signal?: AbortSignal } = {},
): Promise<{ blob: Blob; filename: string | null }> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, RENDERER_TIMEOUT_MS);
    const forwardAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", forwardAbort, { once: true });

    let response: Response;
    try {
        response = await fetch(`${INVOICE_RENDERER_BASE_PATH}/pdf`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/pdf",
            },
            body: JSON.stringify(request),
            signal: controller.signal,
        });
    } catch (error) {
        if (options.signal?.aborted) throw error;
        if (timedOut) {
            throw new InvoiceRendererError(
                "The invoice renderer timed out. Try again.",
                408,
            );
        }
        throw new InvoiceRendererError(
            "The invoice renderer could not be reached.",
            0,
        );
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", forwardAbort);
    }

    if (!response.ok) {
        throw new InvoiceRendererError(
            await readProblemMessage(response),
            response.status,
        );
    }

    return {
        blob: await response.blob(),
        filename: filenameFromContentDisposition(
            response.headers.get("Content-Disposition"),
        ),
    };
}

/** Request a PDF and trigger the browser download. */
export async function downloadInvoicePdf(
    request: InvoiceGenerationRequest,
    options: { signal?: AbortSignal } = {},
): Promise<{ filename: string }> {
    const { blob, filename } = await requestInvoicePdf(request, options);
    const fallback = `faktura-${sanitizeDownloadFilename(
        request.invoice.invoiceNumber,
    )}.pdf`;
    const name = filename
        ? sanitizeDownloadFilename(filename)
        : fallback;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the browser a tick to start the download before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { filename: name };
}
