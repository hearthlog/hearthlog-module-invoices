import { wrap, type DBSchema, type IDBPDatabase } from "idb";
import {
    fetchAccessProtected,
    AccessSessionExpiredError,
} from "@hearthlog/sdk/runtime";
import { requireActiveContext } from "@hearthlog/sdk/runtime";
import {
    commandActionsAvailable,
    commandAvailability,
} from "@hearthlog/sdk/runtime";
import { refreshPageData } from "@hearthlog/sdk/runtime";

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_ISDOC_BYTES = 5 * 1024 * 1024;
const MAX_RETRY_MS = 5 * 60 * 1000;

/** One immutable original per kind: the source PDF and its ISDOC XML. */
export type InvoiceFileKind = "pdf" | "isdoc";

/**
 * The file-bearing fields shared by issued and received invoices. A new file
 * id is a new immutable version, so history can recover older documents.
 */
export interface InvoiceFileRecord {
    tenant_id: string;
    log_id: string;
    id: string;
    file_id: string;
    file_name: string;
    storage_status: string;
    isdoc_file_id: string;
    isdoc_file_name: string;
    isdoc_storage_status: string;
}

export interface InvoiceFileStoreConfig<T extends InvoiceFileRecord> {
    /** IndexedDB database per direction, so queues and caches never collide. */
    dbName: string;
    /** API route prefix, e.g. `/api/received-invoice-files/v1`. */
    apiPrefix: string;
    /** Loads the latest record; used to avoid overwriting newer files. */
    load(invoiceId: string): Promise<T | null>;
    /** Persists the storage status for one kind on the current record. */
    markStorageStatus(
        invoice: T,
        kind: InvoiceFileKind,
        status: string,
    ): Promise<void>;
}

interface Scope {
    tenantId: string;
    logId: string;
    invoiceId: string;
    fileId: string;
    kind: InvoiceFileKind;
}
interface CachedFile extends Scope {
    key: string;
    name: string;
    blob: Blob;
}
interface UploadOperation extends Scope {
    key: string;
    attempts: number;
    nextAttemptAt: number;
    lastError: string;
}
interface FileDatabase extends DBSchema {
    files: { key: string; value: CachedFile };
    uploads: { key: string; value: UploadOperation };
}

function fileIdOf(invoice: InvoiceFileRecord, kind: InvoiceFileKind): string {
    return kind === "isdoc" ? invoice.isdoc_file_id : invoice.file_id;
}

function fileNameOf(invoice: InvoiceFileRecord, kind: InvoiceFileKind): string {
    return kind === "isdoc" ? invoice.isdoc_file_name : invoice.file_name;
}

/** Row/detail label for a stored original's sync state. */
export function invoiceStorageLabel(status: string): string {
    switch (status) {
        case "uploaded":
            return "Saved on the server";
        case "failed":
            return "Upload failed";
        case "missing":
            return "File unavailable";
        default:
            return "Saved on this device";
    }
}

/**
 * Client-side original-document storage shared by issued and received
 * invoices: immutable bytes in IndexedDB plus a durable upload queue that
 * retries into the tenant's R2 bucket through the Worker route.
 */
export function createInvoiceFileStore<T extends InvoiceFileRecord>(
    config: InvoiceFileStoreConfig<T>,
) {
    let dbPromise: Promise<IDBPDatabase<FileDatabase>> | null = null;

    function database(): Promise<IDBPDatabase<FileDatabase>> {
        dbPromise ??= openFileDatabase().catch((error) => {
            // Allow a later attempt to reopen instead of caching the failure.
            dbPromise = null;
            throw error;
        });
        return dbPromise;
    }

    /**
     * Opens the file database without ever forcing a version upgrade.
     *
     * An earlier revision bumped the received database to v2 just to add the
     * `kind` property, which required no store or index change. A tab or
     * window still holding the old version open then blocked that upgrade:
     * `indexedDB.open` stays pending silently and the save flow hung on
     * "Saving…". The database is therefore opened at whatever version already
     * exists (`kindOf` treats rows without `kind` as PDFs), and
     * `onversionchange` closes this connection so a future real upgrade cannot
     * be blocked by us.
     */
    function openFileDatabase(): Promise<IDBPDatabase<FileDatabase>> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(config.dbName);
            let rejected = false;
            const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
                fail(
                    "The local file database did not open. Close other Hearthlog tabs or windows and try again.",
                );
            }, 5000);
            const fail = (message: string) => {
                if (rejected) return;
                rejected = true;
                clearTimeout(timer);
                reject(new Error(message));
            };

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains("files")) {
                    db.createObjectStore("files", { keyPath: "key" });
                }
                if (!db.objectStoreNames.contains("uploads")) {
                    db.createObjectStore("uploads", { keyPath: "key" });
                }
            };
            request.onblocked = () => {
                fail(
                    "Another Hearthlog tab or window is using a different database version. Close it and try again.",
                );
            };
            request.onerror = () => {
                if (!rejected) {
                    clearTimeout(timer);
                    reject(
                        request.error ??
                            new Error(
                                "The local file database could not be opened.",
                            ),
                    );
                }
            };
            request.onsuccess = () => {
                clearTimeout(timer);
                const db = request.result;
                db.onversionchange = () => {
                    db.close();
                    dbPromise = null;
                };
                if (rejected) {
                    db.close();
                    return;
                }
                // `wrap` is untyped generically; the schema is asserted here.
                resolve(wrap(db) as IDBPDatabase<FileDatabase>);
            };
        });
    }

    function kindOf(entry: { kind?: InvoiceFileKind }): InvoiceFileKind {
        return entry.kind === "isdoc" ? "isdoc" : "pdf";
    }
    function keyFor(scope: Omit<Scope, "kind">): string {
        return `${scope.tenantId}:${scope.logId}:${scope.invoiceId}:${scope.fileId}`;
    }
    function endpoint(scope: Scope): string {
        const base = `${config.apiPrefix}/logs/${scope.logId}/invoices/${scope.invoiceId}`;
        return scope.kind === "isdoc"
            ? `${base}/isdoc/${scope.fileId}`
            : `${base}/files/${scope.fileId}`;
    }
    function contentType(kind: InvoiceFileKind): string {
        return kind === "isdoc"
            ? "application/xml; charset=utf-8"
            : "application/pdf";
    }
    function scopeFrom(invoice: T, kind: InvoiceFileKind): Scope {
        return {
            tenantId: invoice.tenant_id,
            logId: invoice.log_id,
            invoiceId: invoice.id,
            fileId: fileIdOf(invoice, kind),
            kind,
        };
    }

    async function validatePdf(file: File): Promise<void> {
        if (file.size < 5 || file.size > MAX_PDF_BYTES)
            throw new Error("Choose a PDF up to 25 MiB.");
        const signature = new Uint8Array(await file.slice(0, 5).arrayBuffer());
        if (String.fromCharCode(...signature) !== "%PDF-")
            throw new Error("Choose a valid PDF file.");
    }

    async function validateIsdoc(file: Blob): Promise<void> {
        if (file.size < 1 || file.size > MAX_ISDOC_BYTES)
            throw new Error("The electronic invoice must be 5 MiB or smaller.");
        const probe = new Uint8Array(await file.slice(0, 8).arrayBuffer());
        let index =
            probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf ? 3 : 0;
        while (
            index < probe.length &&
            [0x09, 0x0a, 0x0d, 0x20].includes(probe[index]!)
        )
            index += 1;
        if (probe[index] !== 0x3c)
            throw new Error("The electronic invoice is not valid XML.");
    }

    async function queueFile(
        invoiceId: string,
        fileId: string,
        file: File | Blob,
        kind: InvoiceFileKind,
    ): Promise<Scope> {
        if (kind === "pdf") await validatePdf(file as File);
        else await validateIsdoc(file);
        const context = await requireActiveContext();
        const scope: Scope = {
            tenantId: context.tenantId,
            logId: context.logId,
            invoiceId,
            fileId,
            kind,
        };
        const key = keyFor(scope);
        const db = await database();
        const tx = db.transaction(["files", "uploads"], "readwrite");
        const name =
            file instanceof File
                ? file.name
                : kind === "isdoc"
                  ? "invoice.isdoc"
                  : "invoice.pdf";
        await Promise.all([
            tx.objectStore("files").put({ ...scope, key, name, blob: file }),
            tx
                .objectStore("uploads")
                .put({
                    ...scope,
                    key,
                    attempts: 0,
                    nextAttemptAt: Date.now(),
                    lastError: "",
                }),
        ]);
        await tx.done;
        // Best effort only: a pending permission-backed promise must never stall
        // the save flow, so this is intentionally not awaited.
        try {
            const persisted = navigator.storage?.persist?.();
            if (persisted)
                void persisted.catch(() => {
                    /* best effort */
                });
        } catch {
            /* best effort */
        }
        return scope;
    }

    function queuePdf(
        invoiceId: string,
        fileId: string,
        file: File,
    ): Promise<Scope> {
        return queueFile(invoiceId, fileId, file, "pdf");
    }

    function queueIsdoc(
        invoiceId: string,
        fileId: string,
        file: Blob,
    ): Promise<Scope> {
        return queueFile(invoiceId, fileId, file, "isdoc");
    }

    async function discardQueuedFile(scope: Scope): Promise<void> {
        const db = await database();
        const key = keyFor(scope);
        const tx = db.transaction(["files", "uploads"], "readwrite");
        await Promise.all([
            tx.objectStore("files").delete(key),
            tx.objectStore("uploads").delete(key),
        ]);
        await tx.done;
    }

    async function getFile(invoice: T, kind: InvoiceFileKind): Promise<Blob> {
        const context = await requireActiveContext();
        if (
            context.tenantId !== invoice.tenant_id ||
            context.logId !== invoice.log_id
        ) {
            throw new Error("Select the invoice’s log to view its document.");
        }
        const scope = scopeFrom(invoice, kind);
        if (!scope.fileId)
            throw new Error(
                kind === "isdoc"
                    ? "This invoice has no electronic invoice."
                    : "This invoice has no PDF.",
            );
        const db = await database();
        const cached = await db.get("files", keyFor(scope));
        if (cached) return cached.blob;
        if (typeof navigator !== "undefined" && !navigator.onLine) {
            throw new Error(
                "This document is not on this device. Connect to the internet to view it.",
            );
        }
        const response = await fetchAccessProtected(endpoint(scope));
        if (!response.ok)
            throw new Error(
                response.status === 404
                    ? "The uploaded document is not available yet."
                    : "The document could not be loaded.",
            );
        const limit = kind === "isdoc" ? MAX_ISDOC_BYTES : MAX_PDF_BYTES;
        const size = Number(response.headers.get("Content-Length"));
        if (Number.isFinite(size) && size > limit)
            throw new Error("The document exceeds the size limit.");
        const blob = await response.blob();
        if (blob.size > limit)
            throw new Error("The document exceeds the size limit.");
        const name =
            fileNameOf(invoice, kind) ||
            (kind === "isdoc" ? "invoice.isdoc" : "invoice.pdf");
        await db.put("files", { ...scope, key: keyFor(scope), name, blob });
        return blob;
    }

    function getPdf(invoice: T): Promise<Blob> {
        return getFile(invoice, "pdf");
    }

    function getIsdoc(invoice: T): Promise<Blob> {
        return getFile(invoice, "isdoc");
    }

    let activeTransfer: Promise<void> | null = null;
    function runUploads(now = Date.now()): Promise<void> {
        activeTransfer ??= performUploads(now).finally(() => {
            activeTransfer = null;
        });
        return activeTransfer;
    }

    async function performUploads(now: number): Promise<void> {
        if (
            !commandActionsAvailable() ||
            (typeof navigator !== "undefined" && !navigator.onLine)
        )
            return;
        const context = await requireActiveContext();
        const db = await database();
        const uploads = (await db.getAll("uploads")).filter(
            (op) =>
                op.tenantId === context.tenantId &&
                op.logId === context.logId &&
                op.nextAttemptAt <= now,
        );
        for (const operation of uploads) {
            if (!commandActionsAvailable()) break;
            const currentContext = await requireActiveContext();
            if (
                currentContext.tenantId !== context.tenantId ||
                currentContext.logId !== context.logId
            )
                break;
            const kind = kindOf(operation);
            try {
                const invoice = await config.load(operation.invoiceId);
                const cached = await db.get("files", operation.key);
                if (!cached) {
                    if (matchesInvoice(invoice, operation.fileId, kind))
                        await markStorage(invoice!, kind, "missing");
                    await db.delete("uploads", operation.key);
                    continue;
                }
                const response = await fetchAccessProtected(
                    endpoint({ ...operation, kind }),
                    {
                        method: "PUT",
                        headers: {
                            "Content-Type": contentType(kind),
                            "X-Stor-Filename": encodeURIComponent(cached.name),
                        },
                        body: cached.blob,
                    },
                );
                if (!response.ok) {
                    if ([400, 413, 415].includes(response.status)) {
                        if (matchesInvoice(invoice, operation.fileId, kind))
                            await markStorage(invoice!, kind, "failed");
                        await db.put("uploads", {
                            ...operation,
                            kind,
                            nextAttemptAt: Number.MAX_SAFE_INTEGER,
                            lastError: "The document was rejected.",
                        });
                        continue;
                    }
                    throw new Error(
                        `Document upload failed (HTTP ${response.status}).`,
                    );
                }
                if (matchesInvoice(invoice, operation.fileId, kind))
                    await markStorage(invoice!, kind, "uploaded");
                await db.delete("uploads", operation.key);
            } catch (error) {
                if (error instanceof AccessSessionExpiredError) break;
                const attempts = operation.attempts + 1;
                await db.put("uploads", {
                    ...operation,
                    kind,
                    attempts,
                    nextAttemptAt:
                        Date.now() +
                        Math.min(
                            MAX_RETRY_MS,
                            1000 * 2 ** Math.min(attempts, 8),
                        ),
                    lastError:
                        error instanceof Error
                            ? error.message
                            : "Upload failed",
                });
            }
        }
        // The page reloads invoices when an upload completes so storage
        // statuses in the list stay current.
        if (uploads.length) await refreshPageData("app:invoices");
    }

    function matchesInvoice(
        invoice: T | null,
        fileId: string,
        kind: InvoiceFileKind,
    ): boolean {
        if (!invoice) return false;
        return fileIdOf(invoice, kind) === fileId;
    }

    async function markStorage(
        invoice: T,
        kind: InvoiceFileKind,
        status: string,
    ): Promise<void> {
        const current = await config.load(invoice.id);
        const fileId = fileIdOf(invoice, kind);
        if (!matchesInvoice(current, fileId, kind)) return;
        await config.markStorageStatus(current!, kind, status);
    }

    async function retryPdf(invoice: T): Promise<void> {
        const scope = scopeFrom(invoice, "pdf");
        const db = await database();
        const key = keyFor(scope);
        if (!(await db.get("files", key)))
            throw new Error("The PDF is not on this device. Upload it again.");
        await db.put("uploads", {
            ...scope,
            key,
            attempts: 0,
            nextAttemptAt: Date.now(),
            lastError: "",
        });
        await runUploads();
    }

    async function retryIsdoc(invoice: T): Promise<void> {
        const scope = scopeFrom(invoice, "isdoc");
        if (!scope.fileId)
            throw new Error("This invoice has no electronic invoice.");
        const db = await database();
        const key = keyFor(scope);
        if (!(await db.get("files", key)))
            throw new Error("The electronic invoice is not on this device.");
        await db.put("uploads", {
            ...scope,
            key,
            attempts: 0,
            nextAttemptAt: Date.now(),
            lastError: "",
        });
        await runUploads();
    }

    function startUploadCoordinator(): () => void {
        let running = false;
        const trigger = () => {
            if (running || !commandActionsAvailable()) return;
            running = true;
            void runUploads()
                .catch((error) =>
                    console.error("Invoice document upload failed", error),
                )
                .finally(() => {
                    running = false;
                });
        };
        const unsubscribe = commandAvailability.subscribe(trigger);
        window.addEventListener("online", trigger);
        window.addEventListener("focus", trigger);
        window.addEventListener("pageshow", trigger);
        const interval = window.setInterval(trigger, 30_000);
        trigger();
        return () => {
            unsubscribe();
            window.removeEventListener("online", trigger);
            window.removeEventListener("focus", trigger);
            window.removeEventListener("pageshow", trigger);
            window.clearInterval(interval);
        };
    }

    return {
        validatePdf,
        validateIsdoc,
        queueFile,
        queuePdf,
        queueIsdoc,
        discardQueuedFile,
        getPdf,
        getIsdoc,
        runUploads,
        retryPdf,
        retryIsdoc,
        startUploadCoordinator,
    };
}
