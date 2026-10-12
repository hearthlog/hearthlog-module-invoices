/**
 * Duplicate detection for invoice records and parties.
 *
 * The invoice business key is the invoice number plus the counterparty: an
 * IČO when both sides know one, otherwise the normalized name. The party key
 * is the IČO first, then the name. Everything here is pure so it can be
 * unit-tested; callers run the number lookup and pass the rows in.
 */

import type { Invoice, ReceivedInvoice } from "../data/invoices.js";
import { resolveInvoiceParty, type InvoicePartySource } from "./document.js";
import { formatInvoiceAmount, formatInvoiceDate } from "./format.js";

/** An existing invoice a new save may duplicate. */
export interface DuplicateInvoice {
    id: string;
    invoiceNumber: string;
    partyName: string;
    partyIco: string;
    issueDate: string;
    amount: number;
}

/** The record being saved, with just the facts the key needs. */
export interface DuplicateTarget {
    /** Current record id on edit; it never matches itself. */
    id?: string | null;
    invoiceNumber: string;
    partyName?: string | null;
    partyIco?: string | null;
}

/** Trim, collapse whitespace and uppercase so "inv 001" matches "INV 001". */
export function normalizeInvoiceNumber(
    value: string | null | undefined,
): string {
    return (value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/** Digits only; an empty string means "no IČO known". */
export function normalizeIco(value: string | null | undefined): string {
    return (value ?? "").replace(/\D/g, "");
}

/** Case- and whitespace-insensitive name for the IČO-less fallback. */
export function normalizePartyName(value: string | null | undefined): string {
    return (value ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleUpperCase("cs-CZ");
}

export function isDuplicate(
    target: DuplicateTarget,
    candidate: DuplicateInvoice,
): boolean {
    if (target.id && candidate.id === target.id) return false;
    const number = normalizeInvoiceNumber(target.invoiceNumber);
    if (!number || number !== normalizeInvoiceNumber(candidate.invoiceNumber)) {
        return false;
    }
    const targetIco = normalizeIco(target.partyIco);
    const candidateIco = normalizeIco(candidate.partyIco);
    if (targetIco && candidateIco) return targetIco === candidateIco;
    const targetName = normalizePartyName(target.partyName);
    const candidateName = normalizePartyName(candidate.partyName);
    return Boolean(targetName && candidateName && targetName === candidateName);
}

export function findDuplicates(
    target: DuplicateTarget,
    candidates: readonly DuplicateInvoice[],
): DuplicateInvoice[] {
    return candidates.filter((candidate) => isDuplicate(target, candidate));
}

export function receivedDuplicateCandidate(
    invoice: ReceivedInvoice,
): DuplicateInvoice {
    return {
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
        partyName: invoice.supplier_name,
        partyIco: invoice.supplier_ico,
        issueDate: invoice.issue_date,
        amount: invoice.amount,
    };
}

/**
 * The counterparty of an issued invoice is the customer. Snapshots are
 * preferred, but `resolveInvoiceParty` also falls back to the directory and
 * throws on a corrupt snapshot; an unreadable party simply cannot match.
 */
export function issuedDuplicateCandidate(
    invoice: Invoice,
    parties: readonly InvoicePartySource[],
): DuplicateInvoice {
    let party: InvoicePartySource | undefined;
    try {
        party = resolveInvoiceParty(invoice, parties, "customer");
    } catch {
        party = undefined;
    }
    return {
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
        partyName: party?.name ?? "",
        partyIco: party?.ico ?? "",
        issueDate: invoice.issue_date,
        amount: invoice.amount,
    };
}

/** Party facts from a stored `supplier_snapshot`/`customer_snapshot`. */
export function partyIdentityFromSnapshot(snapshot: string | null | undefined): {
    name: string;
    ico: string;
} {
    if (!snapshot) return { name: "", ico: "" };
    try {
        const parsed: unknown = JSON.parse(snapshot);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { name: "", ico: "" };
        }
        const record = parsed as Record<string, unknown>;
        return {
            name: typeof record.name === "string" ? record.name : "",
            ico: typeof record.ico === "string" ? record.ico : "",
        };
    } catch {
        return { name: "", ico: "" };
    }
}

/** Party facts needed to detect a duplicate directory record. */
export interface PartyMatchTarget {
    /** Current record id on edit; it never matches itself. */
    id?: string | null;
    name: string;
    ico?: string | null;
}

/**
 * The active party a create or rename would duplicate: an IČO match wins,
 * then a normalized-name match. Merged aliases are not offered.
 */
export function findPartyMatch<
    T extends {
        id: string;
        name: string;
        ico: string | null;
        merged_into?: string | null;
    },
>(
    parties: readonly T[],
    target: PartyMatchTarget,
): T | undefined {
    const ico = normalizeIco(target.ico);
    const name = normalizePartyName(target.name);
    if (ico) {
        const byIco = parties.find(
            (party) =>
                party.id !== target.id &&
                !party.merged_into?.trim() &&
                normalizeIco(party.ico) === ico,
        );
        if (byIco) return byIco;
    }
    if (!name) return undefined;
    return parties.find(
        (party) =>
            party.id !== target.id &&
            !party.merged_into?.trim() &&
            normalizePartyName(party.name) === name,
    );
}

/** Dialog copy for a party that already exists in the directory. */
export function partyMatchMessage(match: {
    name: string;
    ico: string | null;
    street: string;
    city: string;
}): string {
    const facts = [match.name];
    if (match.ico) facts.push(`IČO ${match.ico}`);
    const address = [match.street, match.city].filter(Boolean).join(", ");
    if (address) facts.push(address);
    return (
        `A party with this company ID or name already exists:\n\n` +
        `${facts.join(" · ")}\n\n` +
        "Use the existing record, or create a separate one anyway."
    );
}

/** Dialog copy listing the matches the save would duplicate. */
export function duplicatePromptMessage(
    matches: readonly DuplicateInvoice[],
    role: "supplier" | "customer",
): string {
    const lines = matches.slice(0, 3).map((match) => {
        const facts = [match.invoiceNumber || "No number"];
        if (match.partyName) facts.push(match.partyName);
        if (match.issueDate) facts.push(formatInvoiceDate(match.issueDate));
        if (match.amount > 0) facts.push(formatInvoiceAmount(match.amount));
        return facts.join(" · ");
    });
    if (matches.length > 3) {
        lines.push(`… and ${matches.length - 3} more.`);
    }
    return (
        `An invoice with this number already exists for this ${role}:\n\n` +
        `${lines.join("\n")}\n\n` +
        "Continue only if it is a different document."
    );
}
