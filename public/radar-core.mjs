// ── Radar core (pure) ────────────────────────────────────────
// Attention ordering and severity mapping for PostHog issue rows. No DOM, no IO.

// Rank is attention-first, deliberately NOT the same grouping as severity: a brand new issue is
// less urgent than one that already regressed, yet both share the warn stripe.
const CHANGE_RANK = {
  spiking: 0,
  regressed: 1,
  worsened: 2,
  new: 3,
  quiet: 4,
};

const CHANGE_SEVERITY = {
  spiking: 'crit',
  regressed: 'crit',
  worsened: 'warn',
  new: 'warn',
  quiet: 'dim',
};

const UNKNOWN_RANK = 99;

export function severityFor(change) {
  return CHANGE_SEVERITY[change] || 'dim';
}

// One pass for the per-project summary line and the tab attention badge. Active is every tracked
// issue; spiking and needsHuman are the two conditions that mean "look at this now".
export function summarizeIssues(issues) {
  const list = Array.isArray(issues) ? issues : [];
  let spiking = 0;
  let needsHuman = 0;
  for (const issue of list) {
    if (issue?.change === 'spiking') spiking += 1;
    if (issue?.verdict === 'NEEDS_HUMAN') needsHuman += 1;
  }
  return { active: list.length, spiking, needsHuman };
}

function rankFor(change) {
  const rank = CHANGE_RANK[change];
  return rank == null ? UNKNOWN_RANK : rank;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

// Returns a new array; the input is never mutated. Ties fall back to blast radius (users, then
// occurrences) and finally to the order the backend sent, so a steady poll does not reshuffle rows.
export function sortIssuesByAttention(issues) {
  if (!Array.isArray(issues)) return [];
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => {
      const byRank = rankFor(a.issue?.change) - rankFor(b.issue?.change);
      if (byRank !== 0) return byRank;
      const byUsers = numberOr(b.issue?.users, 0) - numberOr(a.issue?.users, 0);
      if (byUsers !== 0) return byUsers;
      const byOccurrences = numberOr(b.issue?.occurrences, 0) - numberOr(a.issue?.occurrences, 0);
      if (byOccurrences !== 0) return byOccurrences;
      return a.index - b.index;
    })
    .map((entry) => entry.issue);
}
