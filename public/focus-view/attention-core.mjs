// Pure roster ordering, attention-queue cursor, and THE "needs you" rule (bottom of file) shared by
// every surface that reports one. Order is identity-based,
// never status-based: non-dormant sessions first, then alphabetical by name (numeric,
// case-insensitive). A state change never reorders a pill, so the operator keeps a stable
// spatial map of the rail; attention is carried by the pill treatment and the Alt+W jump,
// not by reordering. pickNextAttention walks an already-ordered attention queue (built by the
// caller from this same order) so Alt+W advances top-to-bottom and wraps around.

export function orderRoster(list) {
  return [...list].sort((a, b) =>
    (a.isDormant === b.isDormant ? 0 : a.isDormant ? 1 : -1)
    || String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
}

// Round-robin the next id after currentId. Empty queue -> null; currentId absent (or null)
// starts at the front; a single-element queue stays put. Pure: indices only, no DOM.
export function pickNextAttention(orderedIds, currentId) {
  if (!orderedIds.length) return null;
  const i = orderedIds.indexOf(currentId);
  return orderedIds[(i + 1) % orderedIds.length];
}

// Step one position along an ordered id list, wrapping at both ends. dir < 0 is up (previous), dir >= 0
// is down (next). Empty list -> null; a single element stays put. An absent (or null) currentId starts
// so the first move lands on the correct end: the top going down, the bottom going up. Pure: indices
// only, no DOM. Backs both the rail's roving Arrow nav and the global Alt+Up/Down session jump.
export function pickAdjacent(orderedIds, currentId, dir) {
  if (!orderedIds.length) return null;
  const step = dir < 0 ? -1 : 1;
  const cur = orderedIds.indexOf(currentId);
  const start = cur === -1 ? (step === 1 ? -1 : 0) : cur;
  return orderedIds[(start + step + orderedIds.length) % orderedIds.length];
}

// ── "Needs you": THE definition, for every surface that has one ──
// The desktop rail head and the phone Board render the same "{n} NEED YOU" readout, so the rule behind
// it lives here once. Two hand-synced copies would drift into two numbers under one sentence, which is
// worse than either surface not having the readout at all.
//
// The rule: WAITING (an agent is blocked ON the operator), plus a COMPLETE the operator has not opened
// yet. `unseen` is supplied by the caller (each surface does its own announce-once bookkeeping - the
// rail off its pill's data-unseen, the Board off its own Set), never read back off the DOM here.
//
// RUNNING is excluded on purpose: it is doing exactly what it should, and counting it would make the
// readout mean "how many sessions exist", which teaches the operator to ignore it. FAILED is excluded
// too; it is surfaced by its own loud state treatment, not by this count.
export function needsAttention({ state, unseen } = {}) {
  if (state === 'WAITING') return true;
  return state === 'COMPLETE' && unseen === true;
}

export function countSessionsNeedingAttention(rows) {
  let count = 0;
  for (const row of (rows || [])) {
    if (needsAttention(row || {})) count++;
  }
  return count;
}

// The readout itself. Resting is a real sentence, not an empty slot, so "nothing needs you" is
// distinguishable from "not loaded yet".
export function attentionSummaryText(count) {
  if (count <= 0) return 'ALL CLEAR';
  if (count === 1) return '1 NEEDS YOU';
  return `${count} NEED YOU`;
}
