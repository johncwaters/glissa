// Pure ordering + counting for the phone Board, the screen a phone operator lands on.
//
// The desktop rail is deliberately STABLE (identity order, never status order) because the operator
// keeps a spatial map of a rail they stare at for hours. A phone is the opposite job: it is picked up
// for a minute, one thumb, one screen of rows, to answer "who needs me". So the Board is ATTENTION
// FIRST, and the ordering is the whole point of the screen rather than a betrayal of a stable map.
//
// Import-free on purpose (the state names below are the values of shared/states STATES, which are the
// names themselves), so the core runs under node:test without a bundler resolving the /shared alias.

// Lower sorts first. Only the states that mean something to a carbon unit with a phone are ranked;
// everything else shares the resting rank and keeps its incoming order.
const ATTENTION_RANK = Object.freeze({
  WAITING: 0,   // an agent is blocked ON the operator: the entire reason to pick the phone up
  FAILED: 1,    // broken, and nothing moves until somebody looks
  COMPLETE: 2,  // a finished turn waiting to be read
  RUNNING: 3,   // live and healthy, worth watching but asking for nothing
});
const RESTING_RANK = 4;

function rankOf(state) {
  const rank = ATTENTION_RANK[state];
  return rank === undefined ? RESTING_RANK : rank;
}

// Attention-first, stable within each group. The caller supplies rows in a deterministic base order
// (the Board passes the same alphabetical roster order the desktop rail uses), and this only LIFTS by
// rank: two sessions in the same state keep the order they arrived in, so a row never swaps places with
// its neighbour for a reason the operator cannot see. The index tiebreak makes that explicit rather
// than leaning on the engine's sort stability.
export function orderSessionsForTriage(rows) {
  return [...(rows || [])]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rankOf(a.row?.state) - rankOf(b.row?.state) || a.index - b.index)
    .map((entry) => entry.row);
}

// How many sessions genuinely want a carbon unit right now. This is the SAME rule the desktop rail head
// applies (focus-view.js attentionIds): WAITING, plus a COMPLETE the operator has not opened yet. Both
// surfaces render the identical "{n} NEED YOU" string, so they must report the identical number - two
// readouts that say the same words and disagree are worse than one of them not existing.
//
// `unseen` is supplied by the caller (the Board's own announce-once bookkeeping), never read back off
// the DOM, so this stays a pure function of its input.
//
// Two states are deliberately NOT counted. RUNNING is doing exactly what it should, and counting it
// would make the readout mean "how many sessions exist", which teaches the operator to ignore it. FAILED
// is not counted either, matching the desktop head exactly; it is not lost, because a failed row sorts
// straight to the top of the triage order and is one of the two states that get a loud row treatment.
export function countSessionsNeedingAttention(rows) {
  let count = 0;
  for (const row of (rows || [])) {
    if (row?.state === 'WAITING') { count++; continue; }
    if (row?.state === 'COMPLETE' && row.unseen === true) count++;
  }
  return count;
}

// The Board header's one-line readout. Resting is a real sentence ("ALL CLEAR"), not an empty slot, so
// the line never collapses and the operator can tell "nothing needs you" from "not loaded yet".
export function attentionSummaryText(count) {
  if (count <= 0) return 'ALL CLEAR';
  if (count === 1) return '1 NEEDS YOU';
  return `${count} NEED YOU`;
}
