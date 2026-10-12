/**
 * Browser-side invoice PDF cache and resolver.
 *
 * One PDF is kept per tenant/log/invoice in IndexedDB with the same
 * fingerprint and renderer revision the Worker stores in R2. Resolution is
 * cache-first: a matching device copy needs no network at all, a remote miss
 * that the Worker already generated is saved locally, and only a true miss
 * reaches the renderer. The download action reuses the resolved bytes without
 * another request. A caller can force a regeneration, which skips the device
 * and server copies, renders fresh bytes, and replaces both.
 *
 * Deletions remove the device copy immediately and queue a scoped remote
 * cleanup that survives reloads and offline periods. Cleanup is cancelled
 * when Undo or restore makes the invoice exist again.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
    AccessSessionExpiredError,
    fetchAccessProtected,
} from "@hearthlog/sdk/runtime";
import { db, requireActiveContext } from "@hearthlog/sdk/runtime";
import { queryDatabase } from "@hearthlog/sdk/data";
import type { Invoice } from "../data/invoices.js";
import {
    buildInvoiceGenerationRequest,
    filenameFromContentDisposition,
    sanitizeDownloadFilename,
    InvoiceRendererError,
    type BuildInvoiceRequestOptions,
    type InvoiceGenerationRequest,
} from "./invoice-renderer.js";
import {
    canonicalInvoicePdfRequestKey,
    computeInvoicePdfFingerprint,
    INVOICE_PDF_RENDERER_REVISION,
} from "./invoice-pdf-fingerprint.js";

const DB_NAME = "stor-invoice-pdfs";
const DB_VERSION = 1;
const DOCUMENTS_STORE = "documents";
const OPERATIONS_STORE = "operations";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_MS = 5 * 60 * 1000;
const OBJECT_URL_GRACE_MS = 60_000;

export interface InvoicePdfScope {
    tenantId: string;
    logId: string;
    invoiceId: string;
}

export interface CachedInvoicePdf extends InvoicePdfScope {
    key: string;
    fingerprint: string;
    rendererRevision: number;
    isdocAttached: boolean | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    blob: Blob;
    cachedAt: number;
}

export interface InvoicePdfCleanupOperation extends InvoicePdfScope {
    id: string;
    key: string;
    /** Removal event whose synchronization gates the remote cleanup. */
    eventId: string | null;
    attempts: number;
    nextAttemptAt: number;
    lastError: string;
}

export interface ResolvedInvoicePdf {
    blob: Blob;
    filename: string;
    fingerprint: string;
    requestKey: string;
    rendererRevision: number;
    isdocAttached: boolean | null;
    source: "device" | "server-cache" | "renderer";
}

export interface ResolveInvoicePdfOptions {
    /**
     * Skip the device copy and the Worker's stored object, render fresh bytes
     * from the current invoice, and replace both stored copies. Requires
     * network access even when a device copy exists.
     */
    forceRegenerate?: boolean;
}

export class InvoicePdfOfflineError extends Error {
    constructor(
        message = "You're offline and this invoice version isn't saved on this device. Connect to the internet to load it.",
    ) {
        super(message);
        this.name = "InvoicePdfOfflineError";
    }
}

export class InvoicePdfStaleError extends Error {
    constructor(
        message = "The invoice changed while its PDF was loading. Reload the preview to continue.",
    ) {
        super(message);
        this.name = "InvoicePdfStaleError";
    }
}

interface InvoicePdfDatabase extends DBSchema {
    documents: {
        key: string;
        value: CachedInvoicePdf;
    };
    operations: {
        key: string;
        value: InvoicePdfCleanupOperation;
    };
}

let databasePromise: Promise<IDBPDatabase<InvoicePdfDatabase>> | null = null;
const inflightResolutions = new Map<string, Promise<ResolvedInvoicePdf>>();

function database(): Promise<IDBPDatabase<InvoicePdfDatabase>> {
    if (typeof indexedDB === "undefined") {
        return Promise.reject(new Error("IndexedDB is not available"));
    }
    databasePromise ??= openDB<InvoicePdfDatabase>(DB_NAME, DB_VERSION, {
        upgrade(db) {
            if (!db.objectStoreNames.contains(DOCUMENTS_STORE)) {
                db.createObjectStore(DOCUMENTS_STORE, { keyPath: "key" });
            }
            if (!db.objectStoreNames.contains(OPERATIONS_STORE)) {
                db.createObjectStore(OPERATIONS_STORE, { keyPath: "id" });
            }
        },
    });
    return databasePromise;
}

/**
 * Resolve the current PDF for one invoice, cache-first. Identical requests in
 * this tab share one in-flight promise, so closing and reopening the preview
 * joins the running generation instead of starting another one. Forced
 * regenerations never join a cache-first resolution.
 */
export async function resolveInvoicePdf(
    invoice: Invoice,
    options: BuildInvoiceRequestOptions,
    resolution: ResolveInvoicePdfOptions = {},
): Promise<ResolvedInvoicePdf> {
    const forceRegenerate = resolution.forceRegenerate === true;
    const request = buildInvoiceGenerationRequest(invoice, options);
    const fingerprint = await computeInvoicePdfFingerprint(request);
    const requestKey = canonicalInvoicePdfRequestKey(request);
    const scope = scopeFromInvoice(invoice);
    const coalesceKey = `${scopeKey(scope)}:${fingerprint}${
        forceRegenerate ? ":regenerate" : ""
    }`;

    const pending = inflightResolutions.get(coalesceKey);
    if (pending) return pending;

    const promise = resolveAndCache(
        invoice,
        options,
        scope,
        request,
        fingerprint,
        requestKey,
        forceRegenerate,
    ).finally(() => {
        if (inflightResolutions.get(coalesceKey) === promise) {
            inflightResolutions.delete(coalesceKey);
        }
    });
    inflightResolutions.set(coalesceKey, promise);
    return promise;
}

async function resolveAndCache(
    invoice: Invoice,
    options: BuildInvoiceRequestOptions,
    scope: InvoicePdfScope,
    request: InvoiceGenerationRequest,
    fingerprint: string,
    requestKey: string,
    forceRegenerate: boolean,
): Promise<ResolvedInvoicePdf> {
    // The device copy may only be served while the invoice's own scope is the
    // active one; a log or tenant switch must not expose the previous scope.
    const context = await requireActiveContext().catch(() => null);
    if (
        !context ||
        context.tenantId !== invoice.tenant_id ||
        context.logId !== invoice.log_id
    ) {
        throw new InvoicePdfStaleError();
    }

    if (!forceRegenerate) {
        const cached = await getCachedInvoicePdf(scope, fingerprint);
        if (cached) {
            return {
                blob: cached.blob,
                filename: cached.filename,
                fingerprint: cached.fingerprint,
                requestKey,
                rendererRevision: cached.rendererRevision,
                source: "device",
                isdocAttached: cached.isdocAttached ?? null,
            };
        }
    }

    if (isOffline()) {
        throw forceRegenerate
            ? new InvoicePdfOfflineError(
                  "You're offline. Connect to the internet to regenerate the invoice.",
              )
            : new InvoicePdfOfflineError();
    }

    const response = await requestPdfFromGateway(
        scope,
        request,
        fingerprint,
        forceRegenerate,
    );
    let blob: Blob;
    try {
        blob = await response.blob();
    } catch {
        throw new InvoiceRendererError(
            "The invoice PDF could not be read. Try again.",
            0,
        );
    }
    if (blob.size === 0) {
        throw new InvoiceRendererError(
            "The invoice service returned an empty document. Try again.",
            502,
        );
    }
    const filename = resolveFilename(response, invoice.invoice_number);
    const attachmentHeader = response.headers.get("X-Isdoc-Attached");
    const isdocAttached = attachmentHeader === "true" ? true : attachmentHeader === "false" ? false : null;
    if (request.requireIsdoc && isdocAttached !== true) {
        throw new InvoiceRendererError("The invoice service returned a PDF without the required electronic invoice. Regenerate it after completing the document details.", 502);
    }

    // Never display or persist a document superseded by an edit, deletion or
    // navigation while it was being generated.
    await assertCurrentInvoiceVersion(invoice, options, requestKey);

    await saveCachedInvoicePdf({
        ...scope,
        key: scopeKey(scope),
        fingerprint,
        rendererRevision: INVOICE_PDF_RENDERER_REVISION,
        filename,
        mimeType: "application/pdf",
        sizeBytes: blob.size,
        isdocAttached,
        blob,
        cachedAt: Date.now(),
    });

    return {
        blob,
        filename,
        fingerprint,
        requestKey,
        rendererRevision: INVOICE_PDF_RENDERER_REVISION,
        source: serverCacheSource(response),
        isdocAttached,
    };
}

/** Trigger the browser download using already-resolved bytes. */
export function triggerInvoicePdfDownload(document: {
    blob: Blob;
    filename: string;
}): void {
    const url = URL.createObjectURL(document.blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = sanitizeDownloadFilename(document.filename);
    link.rel = "noopener";
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the browser a tick to start the download; the grace period also
    // covers slow starts without leaking the object URL for the session.
    window.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_GRACE_MS);
}

/** Replace a displayed object URL without cutting off a running download. */
export function revokeInvoicePdfUrl(url: string | null): void {
    if (!url) return;
    window.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_GRACE_MS);
}

async function getCachedInvoicePdf(
    scope: InvoicePdfScope,
    fingerprint: string,
): Promise<CachedInvoicePdf | null> {
    try {
        const databaseHandle = await database();
        const record = await databaseHandle.get(
            DOCUMENTS_STORE,
            scopeKey(scope),
        );
        if (
            !record ||
            record.fingerprint !== fingerprint ||
            record.rendererRevision !== INVOICE_PDF_RENDERER_REVISION ||
            !(record.blob instanceof Blob) ||
            record.blob.size === 0
        ) {
            return null;
        }
        return record;
    } catch {
        // Eviction, private mode and corrupt records behave like a cache miss.
        return null;
    }
}

async function saveCachedInvoicePdf(record: CachedInvoicePdf): Promise<void> {
    try {
        const databaseHandle = await database();
        const transaction = databaseHandle.transaction(
            DOCUMENTS_STORE,
            "readwrite",
        );
        await transaction.objectStore(DOCUMENTS_STORE).put(record);
        await transaction.done;
        await requestPersistentStorage();
    } catch {
        // Quota or eviction failures must not break the successful download.
        try {
            const databaseHandle = await database();
            await databaseHandle.delete(DOCUMENTS_STORE, record.key);
        } catch {
            // The record will simply be replaced or ignored next time.
        }
    }
}

async function removeCachedInvoicePdf(scope: InvoicePdfScope): Promise<void> {
    try {
        const databaseHandle = await database();
        await databaseHandle.delete(DOCUMENTS_STORE, scopeKey(scope));
    } catch {
        // Best effort; the remote cleanup is still queued.
    }
}

/**
 * Remove the device copy and persist a cleanup operation tied to the removal
 * event. The remote marker is written only after that event synchronizes and
 * only while the invoice stays deleted.
 */
export async function queueInvoicePdfDeletion(
    invoice: Invoice,
    eventId: string | null,
): Promise<void> {
    const scope = scopeFromInvoice(invoice);
    const key = scopeKey(scope);
    const operation: InvoicePdfCleanupOperation = {
        ...scope,
        id: `delete:${key}`,
        key,
        eventId,
        attempts: 0,
        nextAttemptAt: Date.now(),
        lastError: "",
    };
    await removeCachedInvoicePdf(scope);
    try {
        const databaseHandle = await database();
        const transaction = databaseHandle.transaction(
            OPERATIONS_STORE,
            "readwrite",
        );
        await transaction.objectStore(OPERATIONS_STORE).put(operation);
        await transaction.done;
    } catch {
        // The device copy is already gone; a later removal queues cleanup again.
    }
}

/**
 * Process queued remote cleanup. Runs after commits/sync, on reconnect and on
 * startup; an operation stays pending while offline, unsynchronized or until
 * its delete endpoint succeeds.
 */
export async function runInvoicePdfCleanup(now = Date.now()): Promise<void> {
    if (isOffline()) return;
    const context = await requireActiveContext().catch(() => null);
    if (!context) return;

    let databaseHandle: IDBPDatabase<InvoicePdfDatabase>;
    try {
        databaseHandle = await database();
    } catch {
        return;
    }
    const operations = (await databaseHandle.getAll(OPERATIONS_STORE))
        .filter(
            (operation) =>
                operation.tenantId === context.tenantId &&
                operation.logId === context.logId &&
                operation.nextAttemptAt <= now,
        )
        .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt);

    for (const operation of operations) {
        const active = await requireActiveContext().catch(() => null);
        if (
            !active ||
            active.tenantId !== context.tenantId ||
            active.logId !== context.logId
        ) {
            break;
        }
        try {
            const removal = await removalEventState(operation);
            if (await invoiceExists(operation.invoiceId)) {
                // The invoice exists again. Cancel only when the removal event
                // is gone or tombstoned by Undo/restore; otherwise the local
                // projection may simply not have caught up yet.
                if (!removal || removal.tombstoned) {
                    await databaseHandle.delete(OPERATIONS_STORE, operation.id);
                }
                continue;
            }
            // Wait until the removal event synchronizes before touching R2.
            if (removal?.pending) continue;
            const response = await fetchAccessProtected(
                invoicePdfCleanupEndpoint(operation),
                { method: "DELETE" },
            );
            if (!response.ok && response.status !== 404) {
                throw new Error(
                    await safeErrorMessage(
                        response,
                        "The saved invoice PDF could not be removed.",
                    ),
                );
            }
            await databaseHandle.delete(OPERATIONS_STORE, operation.id);
        } catch (error) {
            // fetchAccessProtected has already started the Access login flow.
            // Preserve the operation untouched for the post-login retry.
            if (error instanceof AccessSessionExpiredError) break;
            const attempts = operation.attempts + 1;
            const message =
                error instanceof Error
                    ? error.message
                    : "Invoice PDF cleanup failed";
            console.warn("Invoice PDF cleanup will retry:", message);
            await databaseHandle.put(OPERATIONS_STORE, {
                ...operation,
                attempts,
                nextAttemptAt:
                    Date.now() +
                    Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(attempts, 8)),
                lastError: message,
            } satisfies InvoicePdfCleanupOperation);
        }
    }
}

/** Run cleanup after commits/sync, on reconnect, and on a slow interval. */
export function startInvoicePdfCleanupCoordinator(): () => void {
    let running = false;
    const trigger = () => {
        if (running) return;
        running = true;
        void runInvoicePdfCleanup()
            .catch((error) =>
                console.error("Invoice PDF cleanup could not run", error),
            )
            .finally(() => {
                running = false;
            });
    };
    window.addEventListener("online", trigger);
    window.addEventListener("focus", trigger);
    window.addEventListener("pageshow", trigger);
    document.addEventListener("visibilitychange", trigger);
    window.addEventListener("stor:events-changed", trigger);
    const interval = window.setInterval(trigger, 30_000);
    // Reconcile anything left from a previous session immediately.
    trigger();
    return () => {
        window.removeEventListener("online", trigger);
        window.removeEventListener("focus", trigger);
        window.removeEventListener("pageshow", trigger);
        document.removeEventListener("visibilitychange", trigger);
        window.removeEventListener("stor:events-changed", trigger);
        window.clearInterval(interval);
    };
}

async function requestPdfFromGateway(
    scope: InvoicePdfScope,
    request: InvoiceGenerationRequest,
    fingerprint: string,
    forceRegenerate: boolean,
): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetchAccessProtected(
            invoicePdfEndpoint(scope, forceRegenerate),
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/pdf",
                },
                body: JSON.stringify(request),
                signal: controller.signal,
            },
        );
    } catch (error) {
        if (error instanceof AccessSessionExpiredError) throw error;
        if (timedOut) {
            throw new InvoiceRendererError(
                "The invoice PDF took too long to load. Try again.",
                408,
            );
        }
        if (isOffline()) throw new InvoicePdfOfflineError();
        throw new InvoiceRendererError(
            "The invoice service could not be reached. Try again.",
            0,
        );
    } finally {
        window.clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new InvoiceRendererError(
            await readProblemMessage(response),
            response.status,
        );
    }
    const contentType =
        response.headers
            .get("Content-Type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase() ?? "";
    if (contentType !== "application/pdf") {
        throw new InvoiceRendererError(
            "The invoice service returned an unexpected response. Try again.",
            502,
        );
    }
    const servedFingerprint = response.headers.get(
        "X-Invoice-Pdf-Fingerprint",
    );
    if (servedFingerprint && servedFingerprint !== fingerprint) {
        // A mismatching stored document must never be shown as current.
        throw new InvoiceRendererError(
            "The invoice service returned a different document version. Try again.",
            502,
        );
    }
    return response;
}

async function assertCurrentInvoiceVersion(
    invoice: Invoice,
    options: BuildInvoiceRequestOptions,
    expectedRequestKey: string,
): Promise<void> {
    let currentRequestKey: string | null = null;
    try {
        const context = await requireActiveContext();
        if (
            context.tenantId !== invoice.tenant_id ||
            context.logId !== invoice.log_id
        ) {
            throw new InvoicePdfStaleError();
        }
        currentRequestKey = await queryDatabase(async (repositories) => {
            const current = await repositories.invoices.getInvoice(invoice.id);
            if (!current) return null;
            const parties = await repositories.invoices.getInvoiceParties();
            return canonicalInvoicePdfRequestKey(
                buildInvoiceGenerationRequest(current, {
                    suppliers: parties,
                    customers: parties,
                    locale: options.locale,
                    timeZone: options.timeZone,
                    paymentMethod: options.paymentMethod,
                    isOverdue: options.isOverdue,
                }),
            );
        });
    } catch (error) {
        if (error instanceof InvoicePdfStaleError) throw error;
        throw new InvoicePdfStaleError();
    }
    if (currentRequestKey !== expectedRequestKey) {
        throw new InvoicePdfStaleError();
    }
}

async function invoiceExists(invoiceId: string): Promise<boolean> {
    return queryDatabase(async (repositories) =>
        Boolean(await repositories.invoices.getInvoice(invoiceId)),
    ).catch(() => false);
}

async function removalEventState(
    operation: InvoicePdfCleanupOperation,
): Promise<{ pending: boolean; tombstoned: boolean } | null> {
    if (!operation.eventId) return null;
    const context = await requireActiveContext();
    const event = await db
        .selectFrom("raw_events")
        .select(["sync_state", "is_tombstoned"])
        .where("id", "=", operation.eventId)
        .where("tenant_id", "=", context.tenantId)
        .where("log_id", "=", context.logId)
        .executeTakeFirst();
    if (!event) return null;
    return {
        pending: event.sync_state === "pending",
        tombstoned: event.is_tombstoned === 1,
    };
}

function resolveFilename(
    response: Response,
    invoiceNumber: string,
): string {
    const fromHeader = filenameFromContentDisposition(
        response.headers.get("Content-Disposition"),
    );
    if (fromHeader) return sanitizeDownloadFilename(fromHeader);
    return `faktura-${sanitizeDownloadFilename(invoiceNumber)}.pdf`;
}

function serverCacheSource(
    response: Response,
): ResolvedInvoicePdf["source"] {
    return response.headers.get("X-Invoice-Pdf-Cache") === "hit"
        ? "server-cache"
        : "renderer";
}

async function readProblemMessage(response: Response): Promise<string> {
    try {
        const value: unknown = await response.json();
        if (value && typeof value === "object") {
            const record = value as Record<string, unknown>;
            const message =
                (typeof record.detail === "string" && record.detail) ||
                (typeof record.title === "string" && record.title) ||
                (typeof record.error === "string" && record.error);
            if (message) return message;
        }
    } catch {
        // Fall back to the status-based message.
    }
    return `The invoice service returned HTTP ${response.status}. Try again.`;
}

async function safeErrorMessage(
    response: Response,
    fallback: string,
): Promise<string> {
    try {
        const value: unknown = await response.json();
        if (
            value &&
            typeof value === "object" &&
            "error" in value &&
            typeof (value as { error?: unknown }).error === "string"
        ) {
            return (value as { error: string }).error;
        }
    } catch {
        // The endpoint may return an empty or non-JSON body.
    }
    return fallback;
}

async function requestPersistentStorage(): Promise<void> {
    try {
        await navigator.storage?.persist?.();
    } catch {
        // Persistence is an enhancement; IndexedDB still works when denied.
    }
}

function isOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
}

function scopeFromInvoice(invoice: Invoice): InvoicePdfScope {
    return {
        tenantId: invoice.tenant_id,
        logId: invoice.log_id,
        invoiceId: invoice.id,
    };
}

function scopeKey(scope: InvoicePdfScope): string {
    return `${scope.tenantId}:${scope.logId}:${scope.invoiceId}`;
}

function invoicePdfEndpoint(
    scope: Pick<InvoicePdfScope, "logId">,
    forceRegenerate = false,
): string {
    const path = `/api/invoice-generation/logs/${scope.logId}/pdf`;
    return forceRegenerate ? `${path}?force=1` : path;
}

function invoicePdfCleanupEndpoint(
    scope: Pick<InvoicePdfScope, "logId" | "invoiceId">,
): string {
    return `/api/invoice-generation/logs/${scope.logId}/invoices/${scope.invoiceId}`;
}
