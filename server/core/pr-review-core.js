'use strict';

const BOT_LOGINS = new Set(['dependabot[bot]', 'renovate[bot]']);

const VERDICT_TO_PHASE = {
  CLEAN: 'awaiting-checks',
  RESOLVED: 'awaiting-checks',
  CHANGES: 'done',
  ERROR: 'error',
};

function prKey(repoSlug, prNumber) {
  return `${repoSlug}#${prNumber}`;
}

function isFork(pr, opts) {
  if (pr.isCrossRepository === true) return true;
  if (opts.repoOwner && pr.headOwner !== opts.repoOwner) return true;
  return false;
}

function isBotAuthor(pr) {
  if (pr.author.isBot === true) return true;
  return BOT_LOGINS.has(pr.author.login);
}

function filterActionablePrs(prs, opts = {}) {
  return prs.filter((pr) => {
    if (pr.isDraft) return false;
    if (isFork(pr, opts) && !opts.allowForks) return false;
    if (isBotAuthor(pr) && !opts.includeBots) return false;
    return true;
  });
}

function planReviews(prs, state) {
  return prs.filter((pr) => {
    const entry = state[pr.key];
    if (!entry) return true;
    if (entry.inFlight) return false;
    return entry.reviewedHead !== pr.headRefOid;
  });
}

function planMerges(prs, state) {
  return prs.filter((pr) => state[pr.key] && state[pr.key].phase === 'awaiting-checks');
}

function nextState(verdict) {
  return VERDICT_TO_PHASE[verdict] || 'error';
}

function pingFor(kind, ctx = {}) {
  const detail = ctx.summary || ctx.reason;
  const messages = {
    changes: `changes requested on ${ctx.key}${detail ? `: ${detail}` : ''}`,
    resolved: `conflicts resolved on ${ctx.key}, awaiting checks`,
    merged: `merged ${ctx.key}${detail ? ` (${detail})` : ''}`,
    error: `error on ${ctx.key}${detail ? `: ${detail}` : ''}`,
    clean: null,
  };
  if (!(kind in messages)) return null;
  return messages[kind];
}

module.exports = { prKey, filterActionablePrs, planReviews, planMerges, nextState, pingFor };
