/** Persisted invoice facts. Never infer fiscal facts from display strings or VAT IDs. */
import { addDays, differenceInCalendarDays, format } from "date-fns";
import { DEFAULT_PAYMENT_TERM_DAYS, DEFAULT_SUPPLIER_REGISTRATION } from "../config/invoice-defaults.js";

export interface PostalAddress {
    streetName: string;
    buildingNumber: string;
    cityName: string;
    postalCode: string;
    countryCode: "CZ";
    countryName: string;
}

export interface InvoicePartySource {
    id: string;
    name: string;
    street: string;
    city: string;
    ico: string;
    dic: string | null;
    bank_account: string | null;
    registration?: string | null;
    postal_address?: string | null;
    /** Directory-only alias: a merged duplicate points at its survivor. */
    merged_into?: string | null;
}

export interface InvoiceDocumentSource {
    id: string;
    status: string;
    supplier_id: string | null;
    customer_id: string | null;
    document_state?: string | null;
    document_uuid?: string | null;
    vat_applicable?: number | boolean | null;
    electronic_agreement_reference?: string | null;
    supplier_snapshot?: string | null;
    customer_snapshot?: string | null;
    payment_snapshot?: string | null;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function isDocumentUuid(value: string): boolean { return UUID.test(value); }

export function invoiceDocumentState(invoice: Pick<InvoiceDocumentSource, "status" | "document_state">): "draft" | "issued" {
    if (invoice.document_state === "draft" || invoice.document_state === "issued") return invoice.document_state;
    if (invoice.document_state) throw new Error("The invoice document state is invalid. Edit the invoice before exporting it.");
    return invoice.status === "draft" ? "draft" : "issued";
}

/** Local calendar day for a `yyyy-MM-dd` form value or a stored timestamp. */
function calendarDate(value: string): Date | null {
    const date = new Date(value.length <= 10 ? `${value}T12:00:00` : value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Payment term of a stored invoice: whole calendar days from its issue date
 * to its due date. A missing or invalid date falls back to the default term,
 * and a due date before the issue date counts as due on the issue date.
 */
export function invoicePaymentTermDays(
    issueDate: string | null | undefined,
    dueDate: string | null | undefined,
): number {
    const issue = issueDate ? calendarDate(issueDate) : null;
    const due = dueDate ? calendarDate(dueDate) : null;
    if (!issue || !due) return DEFAULT_PAYMENT_TERM_DAYS;
    return Math.max(0, differenceInCalendarDays(due, issue));
}

/**
 * Due date as a `yyyy-MM-dd` calendar date: the issue date plus the payment
 * term in whole days. Empty when the issue date or the term is invalid.
 */
export function invoiceDueDate(issueDate: string, paymentTermDays: number): string {
    const issue = issueDate ? calendarDate(issueDate) : null;
    if (!issue || !Number.isInteger(paymentTermDays) || paymentTermDays < 0) return "";
    return format(addDays(issue, paymentTermDays), "yyyy-MM-dd");
}

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parsePostalAddress(value: string | null | undefined): PostalAddress | undefined {
    if (!value) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error("Complete the street, building number, city, postal code and country for the electronic invoice.");
    }
    if (!record(parsed) || parsed.countryCode !== "CZ" ||
        !["streetName", "cityName", "postalCode", "countryName"].every(key => typeof parsed[key] === "string" && String(parsed[key]).trim()) ||
        typeof parsed.buildingNumber !== "string") {
        throw new Error("Complete the street, building number, city, postal code and country for the electronic invoice.");
    }
    return {
        streetName: String(parsed.streetName), buildingNumber: parsed.buildingNumber,
        cityName: String(parsed.cityName), postalCode: String(parsed.postalCode),
        countryCode: "CZ", countryName: String(parsed.countryName),
    };
}

function storedPostalAddress(value: string | null | undefined): PostalAddress | undefined {
    if (!value) return undefined;
    try {
        return parsePostalAddress(value);
    } catch {
        return undefined;
    }
}

const CITY_POSTAL_LEADING = /^(\d{3}\s?\d{2})\s+(.+)$/;
const CITY_POSTAL_TRAILING = /^(.+?)[,\s]+(\d{3}\s?\d{2})$/;
const STREET_BUILDING = /^(.+?)\s+(\d+[A-Za-z]?(?:\s*\/\s*\d+[A-Za-z]?)?)$/;

/**
 * Derive the structured ISDOC address from the free-form Street and City
 * fields, so the user enters the address once:
 *
 *   street "Ukázková 12"    -> streetName "Ukázková", buildingNumber "12"
 *   city   "110 00 Praha 1" -> postalCode "11000",   cityName "Praha 1"
 *
 * The postal code may lead or trail the city. A missing building number stays
 * an empty string because the profile allows it. Returns null without a
 * postal code and a city name; only those facts cannot be reconstructed.
 */
export function derivePostalAddress(street: string, city: string): PostalAddress | null {
    const streetLine = street.trim();
    const cityLine = city.trim();
    if (!streetLine || !cityLine) return null;

    const leading = CITY_POSTAL_LEADING.exec(cityLine);
    const trailing = leading ? null : CITY_POSTAL_TRAILING.exec(cityLine);
    const postalCode = leading?.[1] ?? trailing?.[2];
    const cityName = (leading?.[2] ?? trailing?.[1] ?? "").trim();
    if (!postalCode || !cityName) return null;

    const building = STREET_BUILDING.exec(streetLine);
    const streetName = (building?.[1] ?? streetLine).trim();
    if (!streetName) return null;

    return {
        streetName,
        buildingNumber: building ? building[2]!.replace(/\s+/g, "") : "",
        cityName,
        postalCode: postalCode.replace(/\s+/g, ""),
        countryCode: "CZ",
        countryName: "Česká republika",
    };
}

/**
 * Structured address for a party. The free-form Street and City fields are
 * the source of truth; a stored structured address is only kept when those
 * fields cannot be parsed (legacy or imported records).
 */
export function postalAddressForParty(
    street: string,
    city: string,
    stored?: string | null,
): PostalAddress | null {
    return derivePostalAddress(street, city) ?? storedPostalAddress(stored) ?? null;
}

export function snapshotInvoiceParty(party: InvoicePartySource): InvoicePartySource {
    // Whitelist document facts; tenant/log, directory aliases and
    // synchronization metadata stay outside the snapshot.
    const address = postalAddressForParty(party.street, party.city, party.postal_address);
    return {
        id: party.id, name: party.name, street: party.street, city: party.city,
        ico: party.ico, dic: party.dic, bank_account: party.bank_account,
        registration: party.registration ?? null,
        postal_address: address ? JSON.stringify(address) : null,
    };
}

/**
 * Follows merge aliases to the active survivor of a directory id. A dangling
 * alias keeps the record itself, and a cycle stops after bounded hops.
 */
export function resolveDirectoryParty<T extends InvoicePartySource>(
    parties: readonly T[],
    id: string | null | undefined,
): T | undefined {
    if (!id) return undefined;
    const byId = new Map(parties.map((party) => [party.id, party]));
    let current = byId.get(id);
    for (let hop = 0; current && hop < 8; hop += 1) {
        const target = current.merged_into?.trim();
        if (!target) return current;
        const next = byId.get(target);
        if (!next) return current;
        current = next;
    }
    return current;
}

/** Directory rows that pickers and listings should offer. */
export function activeParties<T extends InvoicePartySource>(
    parties: readonly T[],
): T[] {
    return parties.filter((party) => !party.merged_into?.trim());
}

export function resolveInvoiceParty(
    invoice: InvoiceDocumentSource,
    parties: readonly InvoicePartySource[],
    role: "supplier" | "customer",
): InvoicePartySource | undefined {
    const id = invoice[`${role}_id`];
    const saved = invoice[`${role}_snapshot`];
    if (!saved) {
        // The directory record may have been merged away; the alias resolves
        // to the survivor that now carries the current details.
        const party = resolveDirectoryParty(parties, id);
        return party ? snapshotInvoiceParty(party) : undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(saved);
    } catch {
        throw new Error(`The saved ${role} details are invalid. Edit the invoice before exporting it.`);
    }
    if (!record(parsed) || parsed.id !== id ||
        !["id", "name", "street", "city", "ico"].every(key => typeof parsed[key] === "string") ||
        !["dic", "bank_account", "registration", "postal_address"].every(key => parsed[key] == null || typeof parsed[key] === "string")) {
        throw new Error(`The saved ${role} details are invalid. Edit the invoice before exporting it.`);
    }
    // SAFETY: the checks above prove every read field is a string or null, the
    // exact shape `snapshotInvoiceParty` produces and consumes.
    return snapshotInvoiceParty(parsed as unknown as InvoicePartySource);
}

export interface InvoicePartyFormValues {
    id: string;
    name: string;
    street: string;
    city: string;
    ico: string;
    dic: string;
    bank_account: string;
    registration: string;
    /** Preserved structured address for records whose display address cannot be parsed. */
    postal_address?: string | null;
}

export function invoicePartyForm(
    party?: InvoicePartySource,
    role?: "supplier" | "customer",
): InvoicePartyFormValues {
    const stored = party?.registration;
    return {
        id: party?.id ?? "", name: party?.name ?? "", street: party?.street ?? "", city: party?.city ?? "",
        ico: party?.ico ?? "", dic: party?.dic ?? "", bank_account: party?.bank_account ?? "",
        // Pre-fill a supplier footer the user never recorded; an explicitly
        // cleared footer ("") stays cleared. The role only hints at the side
        // the form was opened from — it is not stored on the party.
        registration:
            role === "supplier" && stored == null
                ? DEFAULT_SUPPLIER_REGISTRATION
                : (stored ?? ""),
        postal_address: party?.postal_address ?? null,
    };
}

export function invoicePartyFromForm(form: InvoicePartyFormValues): InvoicePartySource {
    const postal_address = postalAddressForParty(form.street, form.city, form.postal_address);
    return {
        id: form.id, name: form.name.trim(), street: form.street.trim(), city: form.city.trim(),
        ico: form.ico.trim(), dic: form.dic.trim() || null, bank_account: form.bank_account.trim() || null,
        // Keep "" for a deliberately cleared footer, so it is not re-filled.
        registration: form.registration.trim(),
        postal_address: postal_address ? JSON.stringify(postal_address) : null,
    };
}
