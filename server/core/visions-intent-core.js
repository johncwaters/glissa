'use strict';

const MAX_INTENT_CHARS = 300;
const MODEL_SOURCE = 'model';
const LEGACY_OPERATOR_SOURCE = 'operator';

function createIntentState() {
  return { global: null, byProject: {} };
}

function createIntentSlot() {
  return { text: '', source: null, ts: 0 };
}

function normalizeProjectKey(projectId) {
  return typeof projectId === 'string' && projectId ? projectId : null;
}

function sanitizeIntentText(raw, { maxChars = MAX_INTENT_CHARS } = {}) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, maxChars).trim();
}

function reviveIntentSlot(raw, { maxChars = MAX_INTENT_CHARS } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = sanitizeIntentText(raw.text, { maxChars });
  if (!text) return null;
  if (raw.source !== MODEL_SOURCE && raw.source !== LEGACY_OPERATOR_SOURCE) return null;
  if (Object.hasOwn(raw, 'ts') && (!Number.isFinite(raw.ts) || raw.ts < 0)) return null;
  const ts = Number.isFinite(raw.ts) ? raw.ts : 0;
  return { text, source: MODEL_SOURCE, ts };
}

// Ids are the stable UUIDs ensureProjectIds assigns, so only a deletion orphans a slot, never a rename.
function pruneIntentProjects(state, projectIds) {
  const current = state || createIntentState();
  if (!Array.isArray(projectIds)) return current;
  const known = new Set(projectIds.filter((id) => normalizeProjectKey(id)));
  const entries = Object.entries(current.byProject || {}).filter(([projectId]) => known.has(projectId));
  if (entries.length === Object.keys(current.byProject || {}).length) return current;
  return { global: current.global, byProject: Object.fromEntries(entries) };
}

function reviveIntentState(raw, { maxChars = MAX_INTENT_CHARS, projectIds = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createIntentState();
  const isScoped = Object.hasOwn(raw, 'global') || Object.hasOwn(raw, 'byProject');
  if (!isScoped) {
    return pruneIntentProjects({ global: reviveIntentSlot(raw, { maxChars }), byProject: {} }, projectIds);
  }
  const rawByProject = raw.byProject && typeof raw.byProject === 'object' && !Array.isArray(raw.byProject)
    ? raw.byProject
    : {};
  const entries = [];
  for (const [projectId, slotRaw] of Object.entries(rawByProject)) {
    const slot = reviveIntentSlot(slotRaw, { maxChars });
    if (!slot || !normalizeProjectKey(projectId)) continue;
    entries.push([projectId, slot]);
  }
  return pruneIntentProjects({
    global: reviveIntentSlot(raw.global, { maxChars }),
    byProject: Object.fromEntries(entries),
  }, projectIds);
}

function intentSlotFor(state, projectId) {
  const current = state || createIntentState();
  const key = normalizeProjectKey(projectId);
  if (!key) return current.global || null;
  const byProject = current.byProject || {};
  return Object.hasOwn(byProject, key) ? byProject[key] : null;
}

// A project with no statement of its own reads the machine-wide one rather than nothing.
function intentTextFor(state, projectId) {
  const own = intentSlotFor(state, projectId);
  if (own?.text) return own.text;
  const global = intentSlotFor(state, null);
  return global?.text ? global.text : '';
}

function isEmptyIntent(state) {
  const current = state || createIntentState();
  if (current.global?.text) return false;
  return Object.keys(current.byProject || {}).length === 0;
}

function sameIntent(left, right) {
  return left.text === right.text && left.source === right.source;
}

function withIntentSlot(state, projectId, slot) {
  const key = normalizeProjectKey(projectId);
  if (!key) return { global: slot, byProject: { ...state.byProject } };
  return { global: state.global, byProject: { ...state.byProject, [key]: slot } };
}

function applyModelIntent(state, { text, now = 0, projectId = null } = {}) {
  const current = state || createIntentState();
  const proposed = sanitizeIntentText(text);
  if (!proposed) return { state: current, changed: false };
  const next = { text: proposed, source: MODEL_SOURCE, ts: Number(now) || 0 };
  const previous = intentSlotFor(current, projectId);
  if (previous && sameIntent(previous, next)) return { state: current, changed: false };
  return { state: withIntentSlot(current, projectId, next), changed: true };
}

function intentSlotPayload(slot) {
  if (!slot) return createIntentSlot();
  return { text: slot.text, source: slot.source, ts: slot.ts };
}

function intentPayload(state) {
  const current = state || createIntentState();
  const entries = Object.entries(current.byProject || {}).map(([projectId, slot]) => [projectId, intentSlotPayload(slot)]);
  return {
    global: current.global ? intentSlotPayload(current.global) : null,
    byProject: Object.fromEntries(entries),
  };
}

module.exports = {
  MAX_INTENT_CHARS,
  applyModelIntent,
  createIntentSlot,
  createIntentState,
  intentPayload,
  intentSlotFor,
  intentSlotPayload,
  intentTextFor,
  isEmptyIntent,
  pruneIntentProjects,
  reviveIntentSlot,
  reviveIntentState,
  sanitizeIntentText,
};
