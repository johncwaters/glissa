'use strict';

// M13 of docs/plan-visions-3.md: every trust field is stamped from which funnel fired, never read from input.
// M16 adds the read half: the lines one dispatch is handed, in the projection's own bullet shape.

const { effectiveRank, projectionBulletFrom } = require('./memory-core');
const { sanitizeOneLine } = require('./text-core');
const { THREAD_ID_PATTERN, THREAD_ID_RE } = require('./visions-intent-core');

const MEMORY_VENDOR = 'glissa';
const MAX_FINDING_ID_CHARS = 120;
const MAX_SERVED_KEYS = 500;
const DEFAULT_BASENAME = 'document';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function basenameOfUri(uri) {
  const value = nonEmptyString(uri);
  if (!value) return DEFAULT_BASENAME;
  const withoutFragment = value.split('#')[0].split('?')[0];
  const segment = withoutFragment.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {}
  return sanitizeOneLine(decoded, 120) || DEFAULT_BASENAME;
}

// The canon tags a folded repo PATH, never the Glissa project id, so two installs of one checkout agree.
function projectTagFor(projectId, scopeProjects) {
  const id = nonEmptyString(projectId);
  if (!id || !Array.isArray(scopeProjects)) return null;
  for (const entry of scopeProjects) {
    if (!entry || entry.id !== id) continue;
    const tag = nonEmptyString(entry.path);
    if (tag) return tag;
  }
  return null;
}

function projectKeyOf(project) {
  return project === null || project === undefined ? '' : String(project);
}

// The thread an intent record belongs to rides its text as a prefix, since the record shape has no column
// for it; anchored to the id shape so prose starting "thread pool sizing: " cannot mint a lineage.
const INTENT_THREAD_PREFIX_RE = new RegExp(`^thread (${THREAD_ID_PATTERN}): `);

function intentRecordText(text, threadId) {
  const body = sanitizeOneLine(text, 600);
  if (!body || !threadId || !THREAD_ID_RE.test(threadId)) return body;
  return `thread ${threadId}: ${body}`;
}

function threadIdOfIntentText(text) {
  const match = INTENT_THREAD_PREFIX_RE.exec(typeof text === 'string' ? text : '');
  return match ? match[1] : null;
}

// One chain per project AND thread: keying on the project alone would supersede four threads out of five.
function intentHeadKey(project, threadId) {
  return `${projectKeyOf(project)}|${threadId || ''}`;
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return null;
  return Math.floor(number);
}

function displayLineOfFix(fix) {
  const line = Number(fix?.range?.start?.line);
  if (!Number.isFinite(line) || line < 0) return 1;
  return Math.floor(line) + 1;
}

function characterOfFix(fix) {
  const character = Number(fix?.range?.start?.character);
  if (!Number.isFinite(character) || character < 0) return 0;
  return Math.floor(character);
}

// Fixes carry no id of their own, so the served identity is the rule plus where it sits.
function servedFindingOf(fix) {
  const code = sanitizeOneLine(fix?.code == null ? 'finding' : fix.code, 60) || 'finding';
  const line = displayLineOfFix(fix);
  return { id: `${code}@${line}:${characterOfFix(fix)}`, line };
}

function servedKey({ uri, version, id }) {
  const stamped = positiveInteger(version);
  return `${nonEmptyString(uri)}|${stamped === null ? 'none' : stamped}|${nonEmptyString(id)}`;
}

// Oldest-first eviction, because a long-lived buffer would otherwise grow one key per served finding.
function createBoundedKeySet(max = MAX_SERVED_KEYS) {
  const cap = positiveInteger(max) || MAX_SERVED_KEYS;
  const keys = new Set();
  return {
    has: (key) => keys.has(key),
    add(key) {
      if (keys.has(key)) return false;
      keys.add(key);
      if (keys.size > cap) keys.delete(keys.values().next().value);
      return true;
    },
    get size() { return keys.size; },
  };
}

function memoryInput({
  kind, layer, project, sourceKind, text, supersedes = null,
}) {
  const body = nonEmptyString(text);
  if (!body) return null;
  return {
    kind,
    layer,
    project: project || null,
    source: { kind: sourceKind, vendor: MEMORY_VENDOR, sessionId: null },
    text: body,
    supersedes: supersedes || null,
  };
}

// Semantic, not episodic: a statement of what is being built is a standing claim, not an observed moment.
function intentMemoryInput({
  text, project = null, supersedes = null, threadId = null,
}) {
  return memoryInput({
    kind: 'intent',
    layer: 'semantic',
    project,
    sourceKind: 'model',
    text: intentRecordText(text, threadId),
    supersedes,
  });
}

// The chain head per project and thread, so a proposal supersedes the one it replaced rather than
// sitting beside it. A record written before the prefix existed heads the unthreaded key.
function latestIntentHeads(records) {
  const heads = new Map();
  const newestByKey = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.kind !== 'intent') continue;
    const key = intentHeadKey(record.project, threadIdOfIntentText(record.text));
    const ts = Number(record.ts);
    if (!Number.isFinite(ts)) continue;
    const seen = newestByKey.get(key);
    if (seen !== undefined && seen >= ts) continue;
    newestByKey.set(key, ts);
    heads.set(key, record.id);
  }
  return heads;
}

/** @param {{ uri: string, project?: string | null, comments?: { line?: unknown, message?: unknown }[] | null, hand?: unknown }} options */
function dispatchMemoryInputs({
  uri, project = null, comments = null, hand = null,
}) {
  const basename = basenameOfUri(uri);
  const inputs = [];
  for (const comment of /** @type {{ line?: unknown, message?: unknown }[]} */ (Array.isArray(comments) ? comments : [])) {
    const line = positiveInteger(comment?.line);
    const message = sanitizeOneLine(comment?.message, 600);
    if (line === null || !message) continue;
    inputs.push(memoryInput({
      kind: 'knowledge', layer: 'episodic', project, sourceKind: 'model', text: `${basename}:${line}: ${message}`,
    }));
  }
  const raised = sanitizeOneLine(hand, 600);
  if (raised) {
    inputs.push(memoryInput({
      kind: 'knowledge', layer: 'episodic', project, sourceKind: 'model', text: `${basename}: ${raised}`,
    }));
  }
  return inputs.filter((input) => input !== null);
}

// Applications only: the editor also refuses on a version race or a timeout, which is no operator verdict.
/** @param {{ uri: string, project?: string | null, fix: { code?: unknown } }} options */
function fixFeedbackInput({ uri, project = null, fix }) {
  const code = sanitizeOneLine(fix?.code == null ? '' : fix.code, 60);
  if (!code) return null;
  return memoryInput({
    kind: 'feedback',
    layer: 'episodic',
    project,
    sourceKind: 'action',
    text: `applied ${code} at ${basenameOfUri(uri)}:${displayLineOfFix(fix)}`,
  });
}

/** @param {{ uri: string, project?: string | null, id: string, line?: number | null }} options */
function servedFeedbackInput({
  uri, project = null, id, line = null,
}) {
  const finding = sanitizeOneLine(id, MAX_FINDING_ID_CHARS);
  if (!finding) return null;
  const at = positiveInteger(line);
  return memoryInput({
    kind: 'feedback',
    layer: 'episodic',
    project,
    sourceKind: 'action',
    text: `served ${finding} at ${basenameOfUri(uri)}${at === null ? '' : `:${at}`}`,
  });
}

/** @param {{ uri: string, project?: string | null, id: string }} options */
function dismissFeedbackInput({ uri, project = null, id }) {
  const finding = sanitizeOneLine(id, MAX_FINDING_ID_CHARS);
  if (!finding) return null;
  return memoryInput({
    kind: 'feedback',
    layer: 'episodic',
    project,
    sourceKind: 'action',
    text: `dismissed ${finding} at ${basenameOfUri(uri)}`,
  });
}

// An editor notification is untrusted input: it names a finding and nothing else, never a rank.
function readDismissParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const uri = nonEmptyString(params.uri) || nonEmptyString(params.textDocument?.uri);
  const id = typeof params.id === 'string' ? sanitizeOneLine(params.id, MAX_FINDING_ID_CHARS) : '';
  if (!uri || !id) return null;
  return { uri, id };
}

// Bounded twice: a dispatch prompt is a budget, and a record is capped but a retrieval set is not.
const MAX_DELIVERED_RECORDS = 8;
const MAX_DELIVERED_CHARS = 4000;

/*
 * The lines one dispatch is handed, rendered in the SAME bullet shape the projection publishes so a
 * delivered line and its published twin normalize to one echo hash. Every line the caller registers
 * with the store, which is what closes the loop against a session quoting its memory back at it.
 */
function memoryDeliveryLines(records, { maxRecords = MAX_DELIVERED_RECORDS, maxChars = MAX_DELIVERED_CHARS } = {}) {
  const lines = [];
  let used = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (lines.length >= maxRecords) break;
    if (!record || typeof record.id !== 'string' || typeof record.text !== 'string') continue;
    const line = projectionBulletFrom({
      ids: [record.id], rank: effectiveRank(record), locked: record.locked === true, text: record.text,
    });
    if (used + line.length + 1 > maxChars) break;
    used += line.length + 1;
    lines.push(line);
  }
  return lines;
}

module.exports = {
  MAX_DELIVERED_CHARS,
  MAX_DELIVERED_RECORDS,
  MAX_FINDING_ID_CHARS,
  MAX_SERVED_KEYS,
  MEMORY_VENDOR,
  basenameOfUri,
  createBoundedKeySet,
  dismissFeedbackInput,
  dispatchMemoryInputs,
  displayLineOfFix,
  fixFeedbackInput,
  intentHeadKey,
  intentMemoryInput,
  latestIntentHeads,
  memoryDeliveryLines,
  projectTagFor,
  readDismissParams,
  servedFeedbackInput,
  servedFindingOf,
  servedKey,
  threadIdOfIntentText,
};
