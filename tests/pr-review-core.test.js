'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prKey,
  filterActionablePrs,
  planReviews,
  planMerges,
  nextState,
  pingFor,
} = require('../server/core/pr-review-core');

function makePr(overrides = {}) {
  return {
    number: 12,
    key: 'owner/repo#12',
    headRefOid: 'abc123',
    isDraft: false,
    isCrossRepository: false,
    headOwner: 'owner',
    author: { login: 'someuser', isBot: false },
    ...overrides,
  };
}

test('prKey formats as repoSlug#prNumber', () => {
  assert.equal(prKey('owner/repo', 12), 'owner/repo#12');
});

test('filterActionablePrs drops a draft PR', () => {
  const prs = [makePr({ isDraft: true })];
  assert.deepEqual(filterActionablePrs(prs), []);
});

test('filterActionablePrs drops a fork via isCrossRepository', () => {
  const prs = [makePr({ isCrossRepository: true })];
  assert.deepEqual(filterActionablePrs(prs), []);
});

test('filterActionablePrs drops a fork via headOwner mismatch when repoOwner is set', () => {
  const prs = [makePr({ headOwner: 'someone-else' })];
  assert.deepEqual(filterActionablePrs(prs, { repoOwner: 'owner' }), []);
});

test('filterActionablePrs keeps headOwner mismatch when repoOwner is not set', () => {
  const prs = [makePr({ headOwner: 'someone-else' })];
  assert.deepEqual(filterActionablePrs(prs), prs);
});

test('filterActionablePrs drops dependabot[bot] and renovate[bot] logins', () => {
  const prs = [
    makePr({ key: 'owner/repo#1', author: { login: 'dependabot[bot]', isBot: false } }),
    makePr({ key: 'owner/repo#2', author: { login: 'renovate[bot]', isBot: false } }),
  ];
  assert.deepEqual(filterActionablePrs(prs), []);
});

test('filterActionablePrs drops author.isBot true', () => {
  const prs = [makePr({ author: { login: 'some-bot', isBot: true } })];
  assert.deepEqual(filterActionablePrs(prs), []);
});

test('filterActionablePrs keeps a normal own-branch non-draft PR', () => {
  const prs = [makePr()];
  assert.deepEqual(filterActionablePrs(prs, { repoOwner: 'owner' }), prs);
});

test('filterActionablePrs includeBots re-includes bot authors', () => {
  const prs = [makePr({ author: { login: 'dependabot[bot]', isBot: false } })];
  assert.deepEqual(filterActionablePrs(prs, { includeBots: true }), prs);
});

test('filterActionablePrs allowForks re-includes forks', () => {
  const prs = [makePr({ isCrossRepository: true })];
  assert.deepEqual(filterActionablePrs(prs, { allowForks: true }), prs);
});

test('planReviews selects a PR with no state entry', () => {
  const prs = [makePr()];
  assert.deepEqual(planReviews(prs, {}), prs);
});

test('planReviews selects a PR whose reviewedHead differs from headRefOid', () => {
  const prs = [makePr({ headRefOid: 'new-sha' })];
  const state = { 'owner/repo#12': { reviewedHead: 'old-sha', phase: 'done', inFlight: false } };
  assert.deepEqual(planReviews(prs, state), prs);
});

test('planReviews skips a PR whose reviewedHead matches headRefOid', () => {
  const prs = [makePr({ headRefOid: 'same-sha' })];
  const state = { 'owner/repo#12': { reviewedHead: 'same-sha', phase: 'done', inFlight: false } };
  assert.deepEqual(planReviews(prs, state), []);
});

test('planReviews skips a PR marked inFlight even if head differs', () => {
  const prs = [makePr({ headRefOid: 'new-sha' })];
  const state = { 'owner/repo#12': { reviewedHead: 'old-sha', phase: 'new', inFlight: true } };
  assert.deepEqual(planReviews(prs, state), []);
});

test('planMerges selects only awaiting-checks phase entries', () => {
  const prs = [
    makePr({ key: 'owner/repo#1', number: 1 }),
    makePr({ key: 'owner/repo#2', number: 2 }),
    makePr({ key: 'owner/repo#3', number: 3 }),
  ];
  const state = {
    'owner/repo#1': { phase: 'awaiting-checks' },
    'owner/repo#2': { phase: 'done' },
    'owner/repo#3': { phase: 'error' },
  };
  assert.deepEqual(planMerges(prs, state), [prs[0]]);
});

test('nextState maps each verdict to the correct phase', () => {
  assert.equal(nextState('CLEAN'), 'awaiting-checks');
  assert.equal(nextState('RESOLVED'), 'awaiting-checks');
  assert.equal(nextState('CHANGES'), 'done');
  assert.equal(nextState('ERROR'), 'error');
});

test('nextState maps an unknown verdict to error', () => {
  assert.equal(nextState('BOGUS'), 'error');
});

test('pingFor returns null for clean', () => {
  assert.equal(pingFor('clean', { key: 'owner/repo#12' }), null);
});

test('pingFor returns a non-null message containing the key for changes', () => {
  const msg = pingFor('changes', { key: 'owner/repo#12', summary: 'needs tests' });
  assert.notEqual(msg, null);
  assert.match(msg, /owner\/repo#12/);
  assert.match(msg, /needs tests/);
});

test('pingFor returns a non-null message containing the key for resolved', () => {
  const msg = pingFor('resolved', { key: 'owner/repo#12' });
  assert.notEqual(msg, null);
  assert.match(msg, /owner\/repo#12/);
});

test('pingFor returns a non-null message containing the key for merged', () => {
  const msg = pingFor('merged', { key: 'owner/repo#12', summary: 'rebase' });
  assert.notEqual(msg, null);
  assert.match(msg, /owner\/repo#12/);
  assert.match(msg, /rebase/);
});

test('pingFor returns a non-null message containing the key for error', () => {
  const msg = pingFor('error', { key: 'owner/repo#12', reason: 'checks failed' });
  assert.notEqual(msg, null);
  assert.match(msg, /owner\/repo#12/);
  assert.match(msg, /checks failed/);
});
