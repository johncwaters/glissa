'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// pr-view-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/pr-view-core.ts');

const keysOf = (prs) => prs.map((pr) => pr.key);

test('prStatusPlaceholder: waits for an initial server status', async () => {
  const { prStatusPlaceholder } = await importCore();
  assert.equal(prStatusPlaceholder(null), 'Waiting for PR auto-review status from the server.');
  assert.equal(prStatusPlaceholder(undefined), 'Waiting for PR auto-review status from the server.');
});

test('prStatusPlaceholder: reports a misconfigured lane with the reason', async () => {
  const { prStatusPlaceholder } = await importCore();
  assert.equal(
    prStatusPlaceholder({ configured: false, reason: 'telegram missing' }),
    'PR auto-review is misconfigured: telegram missing. Open Settings and its PR Review tab.',
  );
});

test('prStatusPlaceholder: reports a disabled lane without a reason', async () => {
  const { prStatusPlaceholder } = await importCore();
  assert.equal(
    prStatusPlaceholder({ configured: false, reason: '' }),
    'PR auto-review is off. Open Settings and its PR Review tab to switch it on.',
  );
});

test('prStatusPlaceholder: reports configured or legacy statuses as waiting for first poll', async () => {
  const { prStatusPlaceholder } = await importCore();
  assert.equal(prStatusPlaceholder({ configured: true }), 'PR auto-review is on. Waiting for the first poll.');
  assert.equal(prStatusPlaceholder({}), 'PR auto-review is on. Waiting for the first poll.');
});

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

test('prNeedsAction: error, changes-requested and conflicting phases need the operator', async () => {
  const { prNeedsAction } = await importCore();
  assert.equal(prNeedsAction({ phase: 'error' }), true);
  assert.equal(prNeedsAction({ phase: 'done' }), true);
  assert.equal(prNeedsAction({ phase: 'changes-requested' }), true);
  assert.equal(prNeedsAction({ phase: 'conflicting' }), true);
});

test('prNeedsAction: healthy in-flight and settled phases do not', async () => {
  const { prNeedsAction } = await importCore();
  assert.equal(prNeedsAction({ phase: 'resolving-conflicts' }), false);
  assert.equal(prNeedsAction({ phase: 'awaiting-checks' }), false);
  assert.equal(prNeedsAction({ phase: 'in-review', inFlight: true }), false);
  assert.equal(prNeedsAction({ phase: 'merged' }), false);
  assert.equal(prNeedsAction({ phase: null }), false);
  assert.equal(prNeedsAction({}), false);
  assert.equal(prNeedsAction(null), false);
});

test('prNeedsAction: pingedError outranks an otherwise calm phase', async () => {
  const { prNeedsAction } = await importCore();
  assert.equal(prNeedsAction({ phase: 'awaiting-checks', pingedError: true }), true);
});

test('prNeedsAction: a resolved wasConflicting flag is history, not an open ask', async () => {
  const { prNeedsAction } = await importCore();
  assert.equal(prNeedsAction({ phase: 'awaiting-checks', wasConflicting: true }), false);
  assert.equal(prNeedsAction({ phase: 'merged', wasConflicting: true }), false);
});

test('prNeedsAction: every PR the tab dot counts as an error also needs action', async () => {
  const { prNeedsAction, summarizePrs } = await importCore();
  const prs = [
    { phase: 'error' },
    { phase: 'merged', pingedError: true },
    { phase: 'awaiting-checks' },
  ];
  assert.equal(summarizePrs(prs).errors, 2);
  assert.equal(prs.filter((pr) => prNeedsAction(pr)).length, 2);
});

test('prAttentionSignature: names each broken PR by repo, number and phase', async () => {
  const { prAttentionSignature } = await importCore();
  const snapshot = { projects: [{ repoSlug: 'me/app', prs: [
    { number: 7, phase: 'error' },
    { number: 8, phase: 'merged', pingedError: true },
    { number: 9, phase: 'awaiting-checks' },
  ] }] };
  assert.equal(prAttentionSignature(snapshot), 'me/app#7:error|me/app#8:merged');
});

test('prAttentionSignature: a phase change on the same PR is a different signature', async () => {
  const { prAttentionSignature } = await importCore();
  const withPhase = (phase) => prAttentionSignature({ projects: [{ repoSlug: 'me/app', prs: [{ number: 7, phase, pingedError: true }] }] });
  assert.notEqual(withPhase('error'), withPhase('conflicting'));
});

test('prAttentionSignature: healthy PRs and absent feeds are the empty signature, never a throw', async () => {
  const { prAttentionSignature } = await importCore();
  assert.equal(prAttentionSignature({ projects: [{ repoSlug: 'me/app', prs: [{ number: 7, phase: 'merged' }] }] }), '');
  assert.equal(prAttentionSignature(null), '');
  assert.equal(prAttentionSignature({}), '');
  assert.equal(prAttentionSignature({ projects: [null, { prs: null }] }), '');
});

test('prAttentionSignature: the same broken PRs in a different order are the same signature', async () => {
  const { prAttentionSignature } = await importCore();
  const rows = [{ number: 7, phase: 'error' }, { number: 8, phase: 'error' }];
  const one = prAttentionSignature({ projects: [{ repoSlug: 'me/app', prs: rows }] });
  const other = prAttentionSignature({ projects: [{ repoSlug: 'me/app', prs: [...rows].reverse() }] });
  assert.equal(one, other);
});

test('prAttentionSignature: an unlabelled project falls back to its id, a numberless PR to a placeholder', async () => {
  const { prAttentionSignature } = await importCore();
  assert.equal(prAttentionSignature({ projects: [{ projectId: 'p1', prs: [{ phase: 'error' }] }] }), 'p1#?:error');
});

test('prAttentionSignature: every PR the tab dot counts as an error is named', async () => {
  const { prAttentionSignature, summarizePrs } = await importCore();
  const prs = [{ number: 1, phase: 'error' }, { number: 2, pingedError: true }, { number: 3, phase: 'in-review' }];
  const signature = prAttentionSignature({ projects: [{ repoSlug: 'me/app', prs }] });
  assert.equal(signature.split('|').length, summarizePrs(prs).errors);
});

test('phaseLabel: known phases read in words, an unknown one keeps its raw string', async () => {
  const { phaseLabel } = await importCore();
  assert.deepEqual(phaseLabel('done'), { label: 'changes requested', known: true });
  assert.deepEqual(phaseLabel(null), { label: 'pending', known: true });
  assert.deepEqual(phaseLabel('sideways'), { label: 'sideways', known: false });
});
