// ── PR review view core (pure) ───────────────────────────────
// Attention ordering and severity mapping for the PR auto-review rows. No DOM, no IO.

import { attentionSignature } from './attention-ack-core.mjs';
import { numberOr, textOr } from './coerce-core.mjs';
import { lanePlaceholder } from './lane-placeholder-core.mjs';

// Rank is attention-first and deliberately coarser than severity: an errored PR and one whose review
// asked for changes both need the operator, but only the error is a lane failure.
const PHASE_RANK = {
  error: 0,
  done: 1,
  'changes-requested': 1,
  conflicting: 2,
  'resolving-conflicts': 2,
  'awaiting-checks': 3,
  'in-review': 3,
  pending: 4,
  merged: 5,
};

const PHASE_SEVERITY = {
  error: 'crit',
  done: 'warn',
  'changes-requested': 'warn',
  conflicting: 'warn',
  'resolving-conflicts': 'warn',
  'awaiting-checks': 'info',
  'in-review': 'info',
  pending: 'dim',
  merged: 'ok',
};

const PHASE_LABEL = {
  error: 'error',
  done: 'changes requested',
  'changes-requested': 'changes requested',
  conflicting: 'conflicting',
  'resolving-conflicts': 'resolving',
  'awaiting-checks': 'awaiting checks',
  'in-review': 'in review',
  pending: 'pending',
  merged: 'merged',
};

const UNKNOWN_RANK = 99;

// The lane has no state entry for a PR it has not reached yet, and sends a null phase for it. That is
// a known state (nothing has happened), not an unrecognized one.
export const PENDING_PHASE = 'pending';

export function prStatusPlaceholder(status) {
  return lanePlaceholder(status, { label: 'PR auto-review', tab: 'PR Review' });
}

export function normalizePhase(phase) {
  return phase == null ? PENDING_PHASE : phase;
}

// An unrecognized phase renders as its raw string rather than a guess; `known` lets a view mark that
// row so the styling can say "this came from a lane we do not have vocabulary for".
export function phaseLabel(phase) {
  const key = normalizePhase(phase);
  const label = PHASE_LABEL[key];
  if (label) return { label, known: true };
  return { label: String(key), known: false };
}

// pingedError outranks the phase: the lane already told the operator something broke, so the row says
// so even while the phase string still reads as an ordinary state. An unrecognized phase stays dim
// rather than guessing, but a review in flight is at least worth an info stripe.
export function severityFor(phase, { inFlight = false, pingedError = false } = {}) {
  if (pingedError) return 'crit';
  const mapped = PHASE_SEVERITY[normalizePhase(phase)];
  if (mapped) return mapped;
  if (inFlight) return 'info';
  return 'dim';
}

// THE errors predicate: what the summary line counts and what the attention signature is built from,
// so the stat and the dot cannot come to disagree about which PR is broken.
export function prHasError(pr) {
  return Boolean(pr?.pingedError) || pr?.phase === 'error';
}

// One pass for the per-project summary line and the tab attention dot.
export function summarizePrs(prs) {
  const list = Array.isArray(prs) ? prs : [];
  let inReview = 0;
  let errors = 0;
  for (const pr of list) {
    if (pr?.inFlight) inReview += 1;
    if (prHasError(pr)) errors += 1;
  }
  return { open: list.length, inReview, errors };
}

// What the PRs dot is acknowledged against: which PRs are broken, and how. Identity plus phase, so a
// resolved error empties the signature and a new one (or the same PR moving to a different broken
// phase) re-lights the dot the operator already cleared.
export function prAttentionSignature(snapshot) {
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  const parts = [];
  for (const project of projects) {
    const label = textOr(project?.repoSlug, textOr(project?.projectId, 'project'));
    const prs = Array.isArray(project?.prs) ? project.prs : [];
    for (const pr of prs) {
      if (!prHasError(pr)) continue;
      parts.push(`${label}#${numberOr(pr?.number, '?')}:${normalizePhase(pr?.phase)}`);
    }
  }
  return attentionSignature(parts);
}

// Phases that mean a carbon unit has to do something: the lane failed, the review asked for changes,
// or the branch is conflicting and nothing is resolving it yet. `resolving-conflicts` is deliberately
// absent (the lane is working on it), and so is a historical `wasConflicting` flag on a PR whose phase
// has moved on: that is resolved history, not an open ask. This is THE needs-action vocabulary; the
// Radar summary and any future consumer read it here rather than re-deriving phase meanings.
const NEEDS_ACTION_PHASES = new Set(['error', 'done', 'changes-requested', 'conflicting']);

export function prNeedsAction(pr) {
  if (pr?.pingedError) return true;
  return NEEDS_ACTION_PHASES.has(normalizePhase(pr?.phase));
}

function rankFor(pr) {
  if (pr?.pingedError) return PHASE_RANK.error;
  const rank = PHASE_RANK[normalizePhase(pr?.phase)];
  return rank == null ? UNKNOWN_RANK : rank;
}

// Returns a new array; the input is never mutated. Ties fall to the newest PR first, then to the order
// the backend sent, so a steady poll does not reshuffle rows.
export function sortPrsByAttention(prs) {
  if (!Array.isArray(prs)) return [];
  return prs
    .map((pr, index) => ({ pr, index }))
    .sort((a, b) => {
      const byRank = rankFor(a.pr) - rankFor(b.pr);
      if (byRank !== 0) return byRank;
      const byNumber = numberOr(b.pr?.number, 0) - numberOr(a.pr?.number, 0);
      if (byNumber !== 0) return byNumber;
      return a.index - b.index;
    })
    .map((entry) => entry.pr);
}
