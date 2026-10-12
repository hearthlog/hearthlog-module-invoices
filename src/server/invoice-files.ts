import {
    authorizeStorRequest,
    LedgerAdminAuthorizationError,
    LedgerAdminConfigurationError,
    type LedgerAdminIdentity,
} from "@hearthlog/sdk/server";
import { LedgerScopeError, verifyLogAppId } from "@hearthlog/sdk/server";
import { readBodyCapped } from "@hearthlog/sdk/server";

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_ISDOC_BYTES = 5 * 1024 * 1024;
/**
 * One literal route for both directions and both file kinds:
 * `.../logs/<logId>/invoices/<invoiceId>/files|isdoc/<fileId>`.
 */
const FILE_ROUTE =
    /^\/api\/(received|issued)-invoice-files\/v1\/logs\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/invoices\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/(files|isdoc)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

type FileKind = "pdf" | "isdoc";
/** Original documents exist for both invoice directions. */
type FileDirection = "received" | "issued";

interface DirectionConfig {
    /** Human-readable label used in messages, e.g. "Received invoice". */
    label: string;
    /** R2 prefixes keep uploaded originals apart from generated PDFs. */
    pdfPrefix: string;
    isdocPrefix: string;
}
const DIRECTIONS = {
    received: {
        label: "Received invoice",
        pdfPrefix: "received/v1",
        isdocPrefix: "received-isdoc/v1",
    },
    issued: {
        label: "Issued invoice",
        pdfPrefix: "issued/v1",
        isdocPrefix: "issued-isdoc/v1",
    },
} satisfies Record<FileDirection, DirectionConfig>;

interface FileRules {
    maxBytes: number;
    contentType: string;
    defaultName: string;
    invalidCode: string;
    invalidMessage: string;
    validSignature(probe: number[]): boolean;
}

const RULES = {
    pdf: {
        maxBytes: MAX_PDF_BYTES,
        contentType: "application/pdf",
        defaultName: "invoice.pdf",
        invalidCode: "invalid_pdf",
        invalidMessage: "The file is not a PDF",
        validSignature: (probe) =>
            probe.length >= 5 &&
            String.fromCharCode(...probe.slice(0, 5)) === "%PDF-",
    },
    isdoc: {
        maxBytes: MAX_ISDOC_BYTES,
        contentType: "application/xml; charset=utf-8",
        defaultName: "invoice.isdoc",
        invalidCode: "invalid_isdoc",
        invalidMessage: "The file is not an ISDOC XML document",
        validSignature: looksLikeXml,
    },
} satisfies Record<FileKind, FileRules>;

export type InvoiceFileEnv = Pick<
    Env,
    | "CF_ACCESS_APP_AUD"
    | "CF_ACCESS_TEAM_DOMAIN"
    | "LEDGER"
    | "LEDGER_AUTH_TOKEN"
    | "STOR_AUTHORIZED_EMAILS"
    | "INVOICE_PDFS"
>;
type Authorizer = (
    request: Request,
    env: InvoiceFileEnv,
) => Promise<LedgerAdminIdentity>;

export function handleReceivedInvoiceFileRequest(
    request: Request,
    env: InvoiceFileEnv,
    authorize: Authorizer = authorizeStorRequest,
): Promise<Response> {
    return handleInvoiceFileRequest("received", request, env, authorize);
}

export function handleIssuedInvoiceFileRequest(
    request: Request,
    env: InvoiceFileEnv,
    authorize: Authorizer = authorizeStorRequest,
): Promise<Response> {
    return handleInvoiceFileRequest("issued", request, env, authorize);
}

/**
 * Stores and serves the original documents of one invoice direction. The
 * direction only selects the route prefix, the R2 key prefix and the labels;
 * validation, authorization and immutability are identical for both.
 */
async function handleInvoiceFileRequest(
    direction: FileDirection,
    request: Request,
    env: InvoiceFileEnv,
    authorize: Authorizer,
): Promise<Response> {
    const config = DIRECTIONS[direction];
    let url: URL;
    try {
        url = new URL(request.url);
    } catch {
        return errorResponse(
            400,
            "invalid_request_url",
            "The request URL is invalid",
        );
    }
    const match = url.pathname.match(FILE_ROUTE);
    if (!match || !["PUT", "GET"].includes(request.method)) {
        return errorResponse(
            404,
            "file_route_not_found",
            "Invoice file route not found",
        );
    }
    const kind: FileKind = match[4] === "isdoc" ? "isdoc" : "pdf";
    const rules = RULES[kind];
    if (!env.LEDGER_AUTH_TOKEN || !env.INVOICE_PDFS) {
        return errorResponse(
            503,
            "files_unconfigured",
            `${config.label} files are not configured`,
        );
    }
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) {
        return errorResponse(
            403,
            "origin_not_allowed",
            "Cross-origin file requests are not allowed",
        );
    }
    try {
        await authorize(request, env);
    } catch (error) {
        return errorResponse(
            error instanceof LedgerAdminConfigurationError ? 503 : 403,
            error instanceof LedgerAdminConfigurationError
                ? "files_unconfigured"
                : "files_forbidden",
            error instanceof LedgerAdminAuthorizationError
                ? "Hearthlog access is required"
                : `${config.label} files are unavailable`,
        );
    }
    let appId: string;
    try {
        appId = await verifyLogAppId(match[2], env);
    } catch (error) {
        return error instanceof LedgerScopeError
            ? errorResponse(error.status, error.code, error.message)
            : errorResponse(
                  503,
                  "ledger_verification_failed",
                  "The selected log could not be verified",
              );
    }
    // Separate uploaded originals from the generated-invoice cache, and the
    // ISDOC XML from the PDF. A new file id creates an immutable version, so
    // history can recover older documents.
    const keyPrefix = kind === "isdoc" ? config.isdocPrefix : config.pdfPrefix;
    const key = `${keyPrefix}/${appId}/${match[2]}/${match[3]}/${match[5]}`;
    if (request.method === "GET") {
        const object = await env.INVOICE_PDFS.get(key);
        if (!object)
            return errorResponse(
                404,
                "file_not_found",
                "The uploaded file was not found",
            );
        const fileName = object.customMetadata?.fileName ?? rules.defaultName;
        return secureResponse(object.body, {
            headers: {
                "Content-Type": rules.contentType,
                "Content-Disposition": contentDisposition(
                    fileName,
                    url.searchParams.get("download") === "1",
                ),
                "Content-Length": String(object.size),
            },
        });
    }

    if (!isContentType(request.headers.get("Content-Type"), kind)) {
        return errorResponse(
            415,
            "unsupported_file_type",
            kind === "pdf" ? "Upload a PDF file" : "Upload an ISDOC XML file",
        );
    }
    const length = request.headers.get("Content-Length");
    if (
        length !== null &&
        (!Number.isSafeInteger(Number(length)) || Number(length) < 1)
    ) {
        return errorResponse(
            400,
            "invalid_content_length",
            "Content-Length must be positive",
        );
    }
    if (length !== null && Number(length) > rules.maxBytes) {
        return tooLarge(rules);
    }
    if (!request.body)
        return errorResponse(400, "file_required", "A file is required");

    // R2 rejects transformed streams ("Provided readable stream must have a
    // known length"), so read the capped bytes and verify the signature before
    // the conditional write instead of piping a limiter stream into put().
    let bytes: Uint8Array;
    try {
        const capped = await readBodyCapped(request.body, rules.maxBytes);
        if (!capped) return tooLarge(rules);
        bytes = capped;
    } catch {
        return errorResponse(
            400,
            "file_unreadable",
            "The uploaded file could not be read",
        );
    }
    if (!rules.validSignature([...bytes.slice(0, 64)])) {
        return errorResponse(415, rules.invalidCode, rules.invalidMessage);
    }
    const fileName = safeFileName(
        request.headers.get("X-Stor-Filename"),
        rules.defaultName,
    );
    const object = await env.INVOICE_PDFS.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: rules.contentType },
        customMetadata: { fileName, uploadedAt: new Date().toISOString() },
    });
    // A retry may arrive after R2 committed but before the browser saw
    // the response. Preserve the immutable original and acknowledge it.
    if (!object) {
        const existing = await env.INVOICE_PDFS.head(key);
        if (!existing) {
            return errorResponse(
                409,
                "file_id_conflict",
                "This file ID already belongs to another file",
            );
        }
        return secureResponse(
            JSON.stringify({
                fileId: match[5],
                size: existing.size,
                etag: existing.httpEtag,
            }),
            {
                headers: { "Content-Type": "application/json; charset=utf-8" },
            },
        );
    }
    return secureResponse(
        JSON.stringify({
            fileId: match[5],
            size: object.size,
            etag: object.httpEtag,
        }),
        {
            headers: { "Content-Type": "application/json; charset=utf-8" },
        },
    );
}

function tooLarge(rules: FileRules): Response {
    const limitMiB = Math.round(rules.maxBytes / (1024 * 1024));
    return errorResponse(
        413,
        "file_too_large",
        `Files must be ${limitMiB} MiB or smaller`,
    );
}

function isContentType(value: string | null, kind: FileKind): boolean {
    const normalized = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (kind === "pdf") return normalized === "application/pdf";
    return (
        normalized === "application/xml" ||
        normalized === "application/x-isdoc" ||
        normalized === "text/xml"
    );
}

/** Accepts UTF-8 XML with an optional BOM and leading whitespace. */
function looksLikeXml(probe: number[]): boolean {
    let index = 0;
    if (probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf) index = 3;
    while (
        index < probe.length &&
        (probe[index] === 0x09 ||
            probe[index] === 0x0a ||
            probe[index] === 0x0d ||
            probe[index] === 0x20)
    ) {
        index += 1;
    }
    return index < probe.length && probe[index] === 0x3c;
}

function safeFileName(value: string | null, fallback: string): string {
    let decoded = value ?? fallback;
    try {
        decoded = decodeURIComponent(decoded);
    } catch {
        /* keep original */
    }
    return (
        decoded
            .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
            .trim()
            .slice(0, 180) || fallback
    );
}

function contentDisposition(fileName: string, download: boolean): string {
    const fallback = fileName
        .replace(/[^a-zA-Z0-9._ -]/g, "_")
        .replace(/["\\]/g, "_");
    return `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function errorResponse(
    status: number,
    code: string,
    message: string,
): Response {
    return secureResponse(JSON.stringify({ code, error: message }), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
    });
}

function secureResponse(
    body: BodyInit | null,
    init: ResponseInit = {},
): Response {
    const headers = new Headers(init.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(body, { ...init, headers });
}
