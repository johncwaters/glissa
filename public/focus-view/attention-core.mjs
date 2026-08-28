// Pure roster ordering, attention-queue cursor, and the shared "needs you" rule. Order is identity-based,
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

// Shared by the desktop rail head and the phone Board, which render the same "{n} NEED YOU" readout and
// so must never report two numbers. `unseen` comes from the caller's own announce-once bookkeeping (the
// rail's pill attribute, the Board's Set), never a DOM read here. RUNNING is excluded because counting
// it would make the readout mean "how many sessions exist"; FAILED because its own loud state treatment
// carries it instead.
/**
 * @param {{ state?: string, unseen?: boolean }} [attention]
 */
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

// Resting is a real sentence, not an empty slot, so "nothing needs you" stays distinguishable from
// "not loaded yet".
export function attentionSummaryText(count) {
  if (count <= 0) return 'ALL CLEAR';
  if (count === 1) return '1 NEEDS YOU';
  return `${count} NEED YOU`;
}

// The More sheet's dot stands for several nested screens at once, so the aggregate is a RANK, not the
// first truthy level: a raised hand (a standing ask) must outrank an arrival dot behind the same sheet.
const ATTENTION_RANK_BY_LEVEL = new Map([['hand', 2]]);
const ATTENTION_RANK_PRESENT = 1;

/**
 * @param {string | boolean | null | undefined} level
 */
export function attentionRank(level) {
  if (!level) return 0;
  if (typeof level === 'string') return ATTENTION_RANK_BY_LEVEL.get(level) || ATTENTION_RANK_PRESENT;
  return ATTENTION_RANK_PRESENT;
}

/**
 * @param {(string | boolean | null | undefined)[]} [levels]
 * @returns {string | boolean}
 */
export function pickStrongestAttention(levels) {
  /** @type {string | boolean} */
  let strongest = false;
  let strongestRank = 0;
  for (const level of (levels || [])) {
    const rank = attentionRank(level);
    if (rank <= strongestRank) continue;
    strongest = typeof level === 'string' ? level : true;
    strongestRank = rank;
  }
  return strongest;
}
