'use strict';

// M13 of docs/plan-visions-3.md: every trust field is stamped from which funnel fired, never read from input.

const MEMORY_VENDOR = 'glissa';
const MAX_FINDING_ID_CHARS = 120;
const MAX_SERVED_KEYS = 500;
const DEFAULT_BASENAME = 'document';
// Unicode "Other": control, format and surrogate code points, none of which belong on a canon line.
const OTHER_CATEGORY_RE = /\p{C}+/gu;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// Glissa-authored lines are single-line by construction, so remembered text cannot forge one.
function sanitizeOneLine(raw, maxChars) {
  const value = String(raw == null ? '' : raw)
    .replace(OTHER_CATEGORY_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value.slice(0, maxChars).trim();
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

function slotKeyOf(project) {
  return project === null || project === undefined ? '' : String(project);
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

function findingIdOf(fix) {
  return servedFindingOf(fix).id;
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
function intentMemoryInput({ text, project = null, supersedes = null }) {
  return memoryInput({
    kind: 'intent',
    layer: 'semantic',
    project,
    sourceKind: 'model',
    text: sanitizeOneLine(text, 600),
    supersedes,
  });
}

// The chain head per slot, so a proposal supersedes the one it replaced rather than sitting beside it.
function latestIntentHeads(records) {
  const heads = new Map();
  const newestByKey = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.kind !== 'intent') continue;
    const key = slotKeyOf(record.project);
    const ts = Number(record.ts);
    if (!Number.isFinite(ts)) continue;
    const seen = newestByKey.get(key);
    if (seen !== undefined && seen >= ts) continue;
    newestByKey.set(key, ts);
    heads.set(key, record.id);
  }
  return heads;
}

function dispatchMemoryInputs({
  uri, project = null, comments = null, hand = null,
}) {
  const basename = basenameOfUri(uri);
  const inputs = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
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

module.exports = {
  MAX_FINDING_ID_CHARS,
  MAX_SERVED_KEYS,
  MEMORY_VENDOR,
  basenameOfUri,
  createBoundedKeySet,
  dismissFeedbackInput,
  dispatchMemoryInputs,
  displayLineOfFix,
  findingIdOf,
  fixFeedbackInput,
  intentMemoryInput,
  latestIntentHeads,
  projectTagFor,
  readDismissParams,
  sanitizeOneLine,
  servedFeedbackInput,
  servedFindingOf,
  servedKey,
  slotKeyOf,
};
