import type {
    PDFArray,
    PDFContext,
    PDFDict,
    PDFDocument,
    PDFObject,
} from 'pdf-lib';
import { parseIsdocXml } from './isdoc.js';
import type { ExtractionResult } from './types.js';

/**
 * Reads the ISDOC XML embedded in a supplier PDF (PDF/A-3 attachment).
 *
 * pdf-lib 1.17 can write attachments but has no attachment reader, so the
 * catalog's `/Names → /EmbeddedFiles` name tree is walked through the public
 * low-level objects. The library is loaded on demand — imported classes are
 * type-only — so the invoices bundle stays light until a PDF is actually read.
 * Everything stays client-side; the PDF never leaves the device.
 */

/** Embedded files above this size are skipped by the content scan. */
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
const MAX_NAME_TREE_DEPTH = 12;

type PdfLibModule = typeof import('pdf-lib');
let pdfLibPromise: Promise<PdfLibModule> | null = null;

function loadPdfLib(): Promise<PdfLibModule> {
    pdfLibPromise ??= import('pdf-lib');
    return pdfLibPromise;
}

export interface EmbeddedAttachment {
    name: string;
    mimeType: string;
    content: Uint8Array;
}

export type AttachmentReadOutcome =
    | { kind: 'ok'; attachments: EmbeddedAttachment[] }
    | { kind: 'unreadable'; message: string };

export type IsdocReadOutcome =
    | { kind: 'found'; result: ExtractionResult; xml: string }
    | { kind: 'none' }
    | { kind: 'unreadable'; message: string };

/** Loads a PDF and returns every embedded attachment it carries. */
export async function extractEmbeddedAttachments(file: Blob): Promise<AttachmentReadOutcome> {
    const lib = await loadPdfLib();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let document: PDFDocument;
    try {
        document = await lib.PDFDocument.load(bytes, { updateMetadata: false });
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        return {
            kind: 'unreadable',
            message: /encrypt/i.test(message)
                ? 'The PDF is encrypted, so its attachments cannot be read.'
                : 'The PDF could not be read.',
        };
    }
    try {
        return { kind: 'ok', attachments: readEmbeddedFiles(lib, document) };
    } catch {
        // A malformed name tree means no readable attachments, not a broken PDF.
        return { kind: 'ok', attachments: [] };
    }
}

/** Loads a PDF and parses the first ISDOC attachment it can find. */
export async function readIsdocFromPdf(file: Blob): Promise<IsdocReadOutcome> {
    const read = await extractEmbeddedAttachments(file);
    if (read.kind === 'unreadable') return read;
    const found = findIsdocAttachment(read.attachments);
    if (!found) return { kind: 'none' };
    return {
        kind: 'found',
        xml: found.xml,
        result: parseIsdocXml(found.xml, { attachmentName: found.attachment.name }),
    };
}

export type IsdocAttachmentOutcome =
    | { kind: 'found'; xml: string; name: string }
    | { kind: 'none' }
    | { kind: 'unreadable'; message: string };

/**
 * Loads a PDF and returns its first ISDOC attachment with the embedded file
 * name, so callers can offer the XML without parsing it as an invoice record.
 */
export async function readIsdocAttachmentFromPdf(
    file: Blob,
): Promise<IsdocAttachmentOutcome> {
    const read = await extractEmbeddedAttachments(file);
    if (read.kind === 'unreadable') return read;
    const found = findIsdocAttachment(read.attachments);
    if (!found) return { kind: 'none' };
    return { kind: 'found', xml: found.xml, name: found.attachment.name };
}

/**
 * Selects the ISDOC candidate: attachments named `*.isdoc` or marked with an
 * ISDOC MIME type are preferred, then any remaining attachment whose content
 * parses as XML with an `Invoice` root in an ISDOC (or absent) namespace.
 */
export function findIsdocAttachment(
    attachments: EmbeddedAttachment[],
): { attachment: EmbeddedAttachment; xml: string } | null {
    const preferred = attachments.filter((attachment) => isIsdocNamed(attachment.name, attachment.mimeType));
    const rest = attachments.filter((attachment) => !isIsdocNamed(attachment.name, attachment.mimeType));
    for (const attachment of [...preferred, ...rest]) {
        const xml = decodeIsdocXml(attachment);
        if (xml !== null) return { attachment, xml };
    }
    return null;
}

function isIsdocNamed(name: string, mimeType: string): boolean {
    if (name.toLowerCase().endsWith('.isdoc')) return true;
    return mimeType.toLowerCase().includes('isdoc');
}

function decodeIsdocXml(attachment: EmbeddedAttachment): string | null {
    if (attachment.content.byteLength === 0 || attachment.content.byteLength > MAX_SCAN_BYTES) {
        return null;
    }
    // Cheap binary rejection before decoding.
    const probe = attachment.content.subarray(0, 256);
    for (const byte of probe) {
        if (byte === 0) return null;
    }
    let text: string;
    try {
        text = new TextDecoder('utf-8').decode(attachment.content);
    } catch {
        return null;
    }
    return isIsdocXml(text) ? text : null;
}

function isIsdocXml(text: string): boolean {
    const trimmed = text.replace(/^\uFEFF/, '').trimStart();
    if (!trimmed.startsWith('<')) return false;
    try {
        const document = new DOMParser().parseFromString(text, 'application/xml');
        const root = document.documentElement;
        if (!root || root.localName !== 'Invoice') return false;
        const namespace = root.namespaceURI;
        return !namespace || namespace.includes('isdoc');
    } catch {
        return false;
    }
}

function readEmbeddedFiles(lib: PdfLibModule, document: PDFDocument): EmbeddedAttachment[] {
    const context = document.context;
    const names = asDict(lib, context, document.catalog.get(lib.PDFName.of('Names')));
    const embeddedFiles = asDict(lib, context, names?.get(lib.PDFName.of('EmbeddedFiles')));
    if (!names || !embeddedFiles) return [];

    const fileSpecs: Array<{ name: string; filespec: PDFDict }> = [];
    collectFileSpecs(lib, context, embeddedFiles, fileSpecs, 0);

    const attachments: EmbeddedAttachment[] = [];
    for (const { name, filespec } of fileSpecs) {
        const attachment = attachmentFromFileSpec(lib, context, name, filespec);
        if (attachment) attachments.push(attachment);
    }
    return attachments;
}

function collectFileSpecs(
    lib: PdfLibModule,
    context: PDFContext,
    node: PDFDict,
    out: Array<{ name: string; filespec: PDFDict }>,
    depth: number,
): void {
    if (depth > MAX_NAME_TREE_DEPTH) return;

    const names = asArray(lib, context, node.get(lib.PDFName.of('Names')));
    if (names) {
        for (let index = 0; index + 1 < names.size(); index += 2) {
            const nameObject = resolveObject(lib, context, names.get(index));
            const filespec = asDict(lib, context, names.get(index + 1));
            if (!filespec) continue;
            const name = nameObject instanceof lib.PDFString || nameObject instanceof lib.PDFHexString
                ? nameObject.decodeText()
                : '';
            out.push({ name, filespec });
        }
    }

    const kids = asArray(lib, context, node.get(lib.PDFName.of('Kids')));
    if (kids) {
        for (let index = 0; index < kids.size(); index += 1) {
            const kid = asDict(lib, context, kids.get(index));
            if (kid) collectFileSpecs(lib, context, kid, out, depth + 1);
        }
    }
}

function attachmentFromFileSpec(
    lib: PdfLibModule,
    context: PDFContext,
    name: string,
    filespec: PDFDict,
): EmbeddedAttachment | null {
    const ef = asDict(lib, context, filespec.get(lib.PDFName.of('EF')));
    if (!ef) return null;
    const streamObject = ef.get(lib.PDFName.of('UF')) ?? ef.get(lib.PDFName.of('F'));
    const stream = resolveObject(lib, context, streamObject);
    const content = streamBytes(lib, stream);
    if (!content) return null;
    const mimeType = stream instanceof lib.PDFStream
        ? pdfNameText(lib, stream.dict.get(lib.PDFName.of('Subtype')))
        : '';
    return { name: name || 'attachment', mimeType, content };
}

function streamBytes(lib: PdfLibModule, stream: PDFObject | undefined): Uint8Array | null {
    if (stream instanceof lib.PDFRawStream) {
        try {
            return lib.decodePDFRawStream(stream).decode();
        } catch {
            // Unsupported filter chain: fall back to the raw bytes; the XML
            // check will reject them unless they happen to be plain text.
            return stream.getContents();
        }
    }
    if (stream instanceof lib.PDFStream) {
        return stream.getContents();
    }
    return null;
}

function resolveObject(lib: PdfLibModule, context: PDFContext, object: PDFObject | undefined): PDFObject | undefined {
    let current = object;
    for (let depth = 0; depth < 16 && current instanceof lib.PDFRef; depth += 1) {
        current = context.lookup(current);
    }
    return current;
}

function asDict(lib: PdfLibModule, context: PDFContext, object: PDFObject | undefined): PDFDict | undefined {
    const resolved = resolveObject(lib, context, object);
    return resolved instanceof lib.PDFDict ? resolved : undefined;
}

function asArray(lib: PdfLibModule, context: PDFContext, object: PDFObject | undefined): PDFArray | undefined {
    const resolved = resolveObject(lib, context, object);
    return resolved instanceof lib.PDFArray ? resolved : undefined;
}

function pdfNameText(lib: PdfLibModule, object: PDFObject | undefined): string {
    return object instanceof lib.PDFName ? object.decodeText() : '';
}
