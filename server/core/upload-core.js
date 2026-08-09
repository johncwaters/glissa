'use strict';

// Pure decisions behind POST /upload/:sessionId (the phone key strip's Image button): which content
// types are accepted and what they are named on disk, when a body is over the cap, how the saved path
// is framed for the PTY, and which of a session's older uploads the retention sweep drops. No IO, so
// the route in server/backend.js stays a thin shell over tested rules.

const path = require('node:path');

// Only the formats Claude Code can read back from a path, and only ones a phone camera roll or
// screenshot actually produces.
const IMAGE_EXTENSION_BY_MIME = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
});

// A phone photo is a few MB; anything past this is not a screenshot the operator meant to send.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// Per-session cap, mirroring the recorder's retainFiles: uploads accumulate unattended.
const UPLOAD_RETAIN_FILES = 20;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// A directory name is built from the session id, so anything that could climb out of the uploads root
// is refused rather than sanitized (a live session id is always a plain uuid).
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** The extension for an accepted image content type, or null for anything else. */
function extensionForImageMime(contentTypeHeader) {
  if (typeof contentTypeHeader !== 'string') return null;
  const mime = contentTypeHeader.split(';')[0].trim().toLowerCase();
  return IMAGE_EXTENSION_BY_MIME[mime] || null;
}

/** Accept verdict for a request's content type: { ok, extension } or { ok, status, error }. */
function decideUploadType(contentTypeHeader) {
  const extension = extensionForImageMime(contentTypeHeader);
  if (!extension) return { ok: false, status: 415, error: 'unsupported image type' };
  return { ok: true, extension };
}

function exceedsUploadCap(bytesReceived, cap = MAX_UPLOAD_BYTES) {
  return bytesReceived > cap;
}

function isSafePathSegment(segment) {
  if (typeof segment !== 'string' || segment.length === 0) return false;
  if (segment === '.' || segment === '..') return false;
  if (path.basename(segment) !== segment) return false;
  return SAFE_SEGMENT_RE.test(segment);
}

/**
 * Upload filename: an ISO timestamp with every character Windows refuses replaced, plus a random
 * suffix so two uploads inside the same millisecond cannot collide. Sorts newest-last
 * lexicographically, which is what the retention sweep relies on. No client string ever reaches it.
 */
function buildUploadFilename({ now, randomSuffix, extension }) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${randomSuffix}${extension}`;
}

/**
 * The saved path as it goes into the PTY: bracketed paste so the terminal takes it as one literal
 * input, and a trailing space so the operator can keep typing words after it. Deliberately carries no
 * CR or LF - the operator presses Enter, not Glissa.
 */
function framePathPaste(absolutePath) {
  return `${PASTE_START}${absolutePath} ${PASTE_END}`;
}

/**
 * Names to unlink so a session's uploads dir keeps only the newest `keep` files. `justWritten` is
 * never returned (the file the current request just saved and is about to paste), and non-upload
 * entries are ignored rather than swept.
 */
function planUploadRetention(filenames, { keep = UPLOAD_RETAIN_FILES, justWritten = null } = {}) {
  if (!Array.isArray(filenames) || keep <= 0) return [];
  const uploads = filenames.filter((name) => extensionIsUpload(name));
  if (justWritten && !uploads.includes(justWritten)) uploads.push(justWritten);
  uploads.sort().reverse();
  return uploads.slice(keep).filter((name) => name !== justWritten);
}

function extensionIsUpload(name) {
  if (typeof name !== 'string') return false;
  const ext = path.extname(name).toLowerCase();
  return Object.values(IMAGE_EXTENSION_BY_MIME).includes(ext);
}

module.exports = {
  MAX_UPLOAD_BYTES,
  UPLOAD_RETAIN_FILES,
  buildUploadFilename,
  decideUploadType,
  exceedsUploadCap,
  extensionForImageMime,
  framePathPaste,
  isSafePathSegment,
  planUploadRetention,
};
