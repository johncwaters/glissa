const BOT_LOGINS = new Set(['dependabot[bot]', 'renovate[bot]']);

const VERDICT_TO_PHASE: Record<string, string> = {
  CLEAN: 'awaiting-checks',
  RESOLVED: 'awaiting-checks',
  CHANGES: 'done',
  ERROR: 'error',
};

export interface PullRequestCandidate {
  isDraft?: boolean;
  isCrossRepository?: boolean;
  headOwner?: string;
  key?: string;
  headRefOid?: string;
  author: { isBot?: boolean; login: string };
}

export interface PullRequestFilterOptions {
  repoOwner?: string;
  allowForks?: boolean;
  includeBots?: boolean;
}

export interface ReviewStateEntry {
  inFlight?: boolean;
  reviewedHead?: string;
  phase?: string;
}

function prKey(repoSlug: string, prNumber: number | string): string {
  return `${repoSlug}#${prNumber}`;
}

function isFork(pr: PullRequestCandidate, opts: PullRequestFilterOptions): boolean {
  if (pr.isCrossRepository === true) return true;
  if (opts.repoOwner && pr.headOwner !== opts.repoOwner) return true;
  return false;
}

function isBotAuthor(pr: PullRequestCandidate): boolean {
  if (pr.author.isBot === true) return true;
  return BOT_LOGINS.has(pr.author.login);
}

function filterActionablePrs<T extends PullRequestCandidate>(prs: T[], opts: PullRequestFilterOptions = {}): T[] {
  return prs.filter((pr) => {
    if (pr.isDraft) return false;
    if (isFork(pr, opts) && !opts.allowForks) return false;
    if (isBotAuthor(pr) && !opts.includeBots) return false;
    return true;
  });
}

function planReviews<T extends { key?: string; headRefOid?: string }>(
  prs: T[],
  state: Record<string, ReviewStateEntry | undefined>,
): T[] {
  return prs.filter((pr) => {
    const entry = state[pr.key ?? ''];
    if (!entry) return true;
    if (entry.inFlight) return false;
    return entry.reviewedHead !== pr.headRefOid;
  });
}

function planMerges<T extends { key?: string }>(prs: T[], state: Record<string, ReviewStateEntry | undefined>): T[] {
  return prs.filter((pr) => state[pr.key ?? ''] && state[pr.key ?? '']?.phase === 'awaiting-checks');
}

function nextState(verdict: string): string {
  return VERDICT_TO_PHASE[verdict] || 'error';
}

function pingFor(kind: string, ctx: { key?: string; summary?: string; reason?: string } = {}): string | null {
  const detail = ctx.summary || ctx.reason;
  const messages: Record<string, string | null> = {
    changes: `changes requested on ${ctx.key}${detail ? `: ${detail}` : ''}`,
    resolved: `conflicts resolved on ${ctx.key}, awaiting checks`,
    merged: `merged ${ctx.key}${detail ? ` (${detail})` : ''}`,
    error: `error on ${ctx.key}${detail ? `: ${detail}` : ''}`,
    clean: null,
  };
  if (!(kind in messages)) return null;
  return messages[kind];
}

export { prKey, filterActionablePrs, planReviews, planMerges, nextState, pingFor };
