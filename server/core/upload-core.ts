import path from 'node:path';

const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
});

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const UPLOAD_RETAIN_FILES = 20;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export type UploadTypeVerdict =
  | { ok: true; extension: string }
  | { ok: false; status: number; error: string };

function extensionForImageMime(contentTypeHeader: unknown): string | null {
  if (typeof contentTypeHeader !== 'string') return null;
  const mime = contentTypeHeader.split(';')[0].trim().toLowerCase();
  return IMAGE_EXTENSION_BY_MIME[mime] || null;
}

function decideUploadType(contentTypeHeader: unknown): UploadTypeVerdict {
  const extension = extensionForImageMime(contentTypeHeader);
  if (!extension) return { ok: false, status: 415, error: 'unsupported image type' };
  return { ok: true, extension };
}

function exceedsUploadCap(bytesReceived: number, cap: number = MAX_UPLOAD_BYTES): boolean {
  return bytesReceived > cap;
}

function isSafePathSegment(segment: unknown): boolean {
  if (typeof segment !== 'string' || segment.length === 0) return false;
  if (segment === '.' || segment === '..') return false;
  if (path.basename(segment) !== segment) return false;
  return SAFE_SEGMENT_RE.test(segment);
}

function buildUploadFilename({ now, randomSuffix, extension }: { now: number; randomSuffix: string; extension: string }): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${randomSuffix}${extension}`;
}

function framePathPaste(absolutePath: string): string {
  return `${PASTE_START}${absolutePath} ${PASTE_END}`;
}

function planUploadRetention(
  filenames: unknown,
  { keep = UPLOAD_RETAIN_FILES, justWritten = null }: { keep?: number; justWritten?: string | null } = {},
): string[] {
  if (!Array.isArray(filenames) || keep <= 0) return [];
  const uploads: string[] = filenames.filter((name): name is string => extensionIsUpload(name));
  if (justWritten && !uploads.includes(justWritten)) uploads.push(justWritten);
  uploads.sort().reverse();
  return uploads.slice(keep).filter((name) => name !== justWritten);
}

function extensionIsUpload(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const ext = path.extname(name).toLowerCase();
  return Object.values(IMAGE_EXTENSION_BY_MIME).some((extension) => extension === ext);
}

export { MAX_UPLOAD_BYTES, UPLOAD_RETAIN_FILES, buildUploadFilename, decideUploadType, exceedsUploadCap, extensionForImageMime, framePathPaste, isSafePathSegment, planUploadRetention };
