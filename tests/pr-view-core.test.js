'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// pr-view-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/pr-view-core.mjs');

const keysOf = (prs) => prs.map((pr) => pr.key);

test('severityFor: crit for error, warn for changes and conflicts, info for checks, ok for merged', async () => {
  const { severityFor } = await importCore();
  assert.equal(severityFor('error'), 'crit');
  assert.equal(severityFor('done'), 'warn');
  assert.equal(severityFor('changes-requested'), 'warn');
  assert.equal(severityFor('conflicting'), 'warn');
  assert.equal(severityFor('awaiting-checks'), 'info');
  assert.equal(severityFor('in-review'), 'info');
  assert.equal(severityFor('merged'), 'ok');
});

test('severityFor: pingedError outranks the phase', async () => {
  const { severityFor } = await importCore();
  assert.equal(severityFor('merged', { pingedError: true }), 'crit');
  assert.equal(severityFor('awaiting-checks', { pingedError: true }), 'crit');
});

test('severityFor: an unknown phase is dim, or info while a review is in flight', async () => {
  const { severityFor } = await importCore();
  assert.equal(severityFor('sideways'), 'dim');
  assert.equal(severityFor('sideways', { inFlight: true }), 'info');
  assert.equal(severityFor('merged', { inFlight: true }), 'ok');
});

test('severityFor: a null phase is the pending state, dim even while in flight', async () => {
  const { severityFor } = await importCore();
  assert.equal(severityFor(null), 'dim');
  assert.equal(severityFor(undefined), 'dim');
  assert.equal(severityFor('pending'), 'dim');
  assert.equal(severityFor(null, { inFlight: true }), 'dim');
  assert.equal(severityFor(null, { pingedError: true }), 'crit');
});

test('normalizePhase: a null or absent phase reads as pending, anything else is untouched', async () => {
  const { normalizePhase } = await importCore();
  assert.equal(normalizePhase(null), 'pending');
  assert.equal(normalizePhase(undefined), 'pending');
  assert.equal(normalizePhase('merged'), 'merged');
  assert.equal(normalizePhase('sideways'), 'sideways');
});

test('sortPrsByAttention: orders error, changes, conflicts, awaiting checks, pending, merged', async () => {
  const { sortPrsByAttention } = await importCore();
  const prs = [
    { key: 'merged', phase: 'merged' },
    { key: 'unreviewed', phase: null },
    { key: 'checks', phase: 'awaiting-checks' },
    { key: 'conflict', phase: 'conflicting' },
    { key: 'changes', phase: 'done' },
    { key: 'broken', phase: 'error' },
  ];
  assert.deepEqual(keysOf(sortPrsByAttention(prs)), ['broken', 'changes', 'conflict', 'checks', 'unreviewed', 'merged']);
});

test('sortPrsByAttention: pingedError ranks with the errors regardless of phase', async () => {
  const { sortPrsByAttention } = await importCore();
  const prs = [
    { key: 'calm', phase: 'awaiting-checks' },
    { key: 'pinged', phase: 'merged', pingedError: true },
  ];
  assert.deepEqual(keysOf(sortPrsByAttention(prs)), ['pinged', 'calm']);
});

test('sortPrsByAttention: same phase puts the newest PR number first', async () => {
  const { sortPrsByAttention } = await importCore();
  const prs = [
    { key: 'old', phase: 'error', number: 4 },
    { key: 'new', phase: 'error', number: 91 },
    { key: 'mid', phase: 'error', number: 40 },
  ];
  assert.deepEqual(keysOf(sortPrsByAttention(prs)), ['new', 'mid', 'old']);
});

test('sortPrsByAttention: fully tied rows keep the order the backend sent', async () => {
  const { sortPrsByAttention } = await importCore();
  const prs = [
    { key: 'first', phase: 'done', number: 7 },
    { key: 'second', phase: 'done', number: 7 },
    { key: 'third', phase: 'done', number: 7 },
  ];
  assert.deepEqual(keysOf(sortPrsByAttention(prs)), ['first', 'second', 'third']);
});

test('sortPrsByAttention: an unknown phase sorts last rather than jumping the queue', async () => {
  const { sortPrsByAttention } = await importCore();
  const prs = [
    { key: 'weird', phase: 'sideways' },
    { key: 'merged', phase: 'merged' },
    { key: 'broken', phase: 'error' },
  ];
  assert.deepEqual(keysOf(sortPrsByAttention(prs)), ['broken', 'merged', 'weird']);
});

test('sortPrsByAttention: does not mutate the input array', async () => {
  const { sortPrsByAttention } = await importCore();
  const prs = [{ key: 'merged', phase: 'merged' }, { key: 'broken', phase: 'error' }];
  const sorted = sortPrsByAttention(prs);
  assert.deepEqual(keysOf(prs), ['merged', 'broken']);
  assert.deepEqual(keysOf(sorted), ['broken', 'merged']);
});

test('sortPrsByAttention: a non-array input returns an empty array', async () => {
  const { sortPrsByAttention } = await importCore();
  assert.deepEqual(sortPrsByAttention(undefined), []);
  assert.deepEqual(sortPrsByAttention(null), []);
});

test('summarizePrs: counts open PRs, in-flight reviews and errors', async () => {
  const { summarizePrs } = await importCore();
  const prs = [
    { key: 'a', phase: 'error' },
    { key: 'b', phase: 'awaiting-checks', inFlight: true },
    { key: 'c', phase: 'merged', pingedError: true },
    { key: 'd', phase: 'done' },
  ];
  assert.deepEqual(summarizePrs(prs), { open: 4, inReview: 1, errors: 2 });
});

test('summarizePrs: a non-array or empty input summarizes to zeroes', async () => {
  const { summarizePrs } = await importCore();
  assert.deepEqual(summarizePrs([]), { open: 0, inReview: 0, errors: 0 });
  assert.deepEqual(summarizePrs(undefined), { open: 0, inReview: 0, errors: 0 });
  assert.deepEqual(summarizePrs(null), { open: 0, inReview: 0, errors: 0 });
});

test('summarizePrs: malformed entries never throw', async () => {
  const { summarizePrs } = await importCore();
  assert.deepEqual(summarizePrs([null, undefined, {}]), { open: 3, inReview: 0, errors: 0 });
});
