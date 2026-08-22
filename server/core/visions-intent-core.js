/*
 * Pure intent-model state for the Visions lane (docs/archive/plan-navigator.md, M5): the short living
 * statement of what the Visions lane believes the carbon unit is building. Every merge is decided HERE,
 * so no caller has to remember that a locked (operator-corrected) statement outranks a model
 * proposal. No IO and no clock: the caller passes `now` in and gets the next state back.
 */

'use strict';

const MAX_INTENT_CHARS = 300;
const MODEL_SOURCE = 'model';
const OPERATOR_SOURCE = 'operator';

// An empty statement is the ABSENCE of one: no text, no source, unlocked, and no stale timestamp.
function createIntentState() {
  return { text: '', source: null, locked: false, ts: 0 };
}

// Both paths sanitize identically: strings only, trimmed, and hard-capped so neither a model nor a
// paste can grow the statement past what the tab renders and the next prompt carries.
function sanitizeIntentText(raw, { maxChars = MAX_INTENT_CHARS } = {}) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, maxChars).trim();
}

function reviveIntentState(raw, { maxChars = MAX_INTENT_CHARS } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createIntentState();
  const text = sanitizeIntentText(raw.text, { maxChars });
  if (!text) return createIntentState();
  if (raw.source !== MODEL_SOURCE && raw.source !== OPERATOR_SOURCE) return createIntentState();
  const locked = raw.locked === true;
  if (locked && raw.source !== OPERATOR_SOURCE) return createIntentState();
  if (Object.hasOwn(raw, 'ts') && (!Number.isFinite(raw.ts) || raw.ts < 0)) return createIntentState();
  const ts = Number.isFinite(raw.ts) ? raw.ts : 0;
  return {
    text, source: raw.source, locked, ts,
  };
}

function isEmptyIntent(state) {
  return !state || !state.text;
}

function sameIntent(left, right) {
  return left.text === right.text && left.source === right.source && left.locked === right.locked;
}

// A merge that lands on the state it started from is not a change, so it costs no broadcast and no new
// timestamp: the age reads "since the statement last moved", not "since a model last agreed with it".
function settle(previous, next) {
  if (sameIntent(previous, next)) return { state: previous, changed: false };
  return { state: next, changed: true };
}

/**
 * A model proposal, carried by a dispatch result. It replaces the statement only while control is
 * with the model: a locked statement is kept, which is the rule this module exists to hold.
 */
function applyModelIntent(state, { text, now = 0 } = {}) {
  const current = state || createIntentState();
  if (current.locked) return { state: current, changed: false };
  const proposed = sanitizeIntentText(text);
  // A model with nothing to say leaves the statement standing; only an operator can clear one.
  if (!proposed) return { state: current, changed: false };
  return settle(current, {
    text: proposed, source: MODEL_SOURCE, locked: false, ts: Number(now) || 0,
  });
}

/**
 * An operator correction. Text takes control and locks it; EMPTY text clears the statement entirely
 * and unlocks, which is how control is handed back to the model.
 */
function applyOperatorIntent(state, { text, now = 0 } = {}) {
  const current = state || createIntentState();
  const corrected = sanitizeIntentText(text);
  if (!corrected) return settle(current, createIntentState());
  return settle(current, {
    text: corrected, source: OPERATOR_SOURCE, locked: true, ts: Number(now) || 0,
  });
}

// The wire shape, copied so nothing downstream holds the lane's own object.
function intentPayload(state) {
  const current = state || createIntentState();
  return {
    text: current.text, source: current.source, locked: current.locked, ts: current.ts,
  };
}

module.exports = {
  MAX_INTENT_CHARS,
  applyModelIntent,
  applyOperatorIntent,
  createIntentState,
  intentPayload,
  isEmptyIntent,
  reviveIntentState,
  sanitizeIntentText,
};
