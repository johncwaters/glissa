'use strict';

const MAX_INTENT_CHARS = 300;
const MODEL_SOURCE = 'model';
const LEGACY_OPERATOR_SOURCE = 'operator';

function createIntentState() {
  return { text: '', source: null, ts: 0 };
}

function sanitizeIntentText(raw, { maxChars = MAX_INTENT_CHARS } = {}) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, maxChars).trim();
}

function reviveIntentState(raw, { maxChars = MAX_INTENT_CHARS } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createIntentState();
  const text = sanitizeIntentText(raw.text, { maxChars });
  if (!text) return createIntentState();
  if (raw.source !== MODEL_SOURCE && raw.source !== LEGACY_OPERATOR_SOURCE) return createIntentState();
  if (Object.hasOwn(raw, 'ts') && (!Number.isFinite(raw.ts) || raw.ts < 0)) return createIntentState();
  const ts = Number.isFinite(raw.ts) ? raw.ts : 0;
  return {
    text, source: MODEL_SOURCE, ts,
  };
}

function isEmptyIntent(state) {
  return !state || !state.text;
}

function sameIntent(left, right) {
  return left.text === right.text && left.source === right.source;
}

function settle(previous, next) {
  if (sameIntent(previous, next)) return { state: previous, changed: false };
  return { state: next, changed: true };
}

function applyModelIntent(state, { text, now = 0 } = {}) {
  const current = state || createIntentState();
  const proposed = sanitizeIntentText(text);
  if (!proposed) return { state: current, changed: false };
  return settle(current, {
    text: proposed, source: MODEL_SOURCE, ts: Number(now) || 0,
  });
}

function intentPayload(state) {
  const current = state || createIntentState();
  return {
    text: current.text, source: current.source, ts: current.ts,
  };
}

module.exports = {
  MAX_INTENT_CHARS,
  applyModelIntent,
  createIntentState,
  intentPayload,
  isEmptyIntent,
  reviveIntentState,
  sanitizeIntentText,
};
