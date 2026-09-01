import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePhase, phaseLabel, prAttentionSignature, prNeedsAction,
  prStatusPlaceholder, severityFor, sortPrsByAttention, summarizePrs,
} from '../public/pr-view-core.ts';
import type { PrRow } from '../public/pr-view-core.ts';

const labelsOf = (prs: PrRow[]): (string | undefined)[] => prs.map((pr) => pr.title);

test('prStatusPlaceholder: waits for an initial server status', () => {
  assert.equal(prStatusPlaceholder(null), 'Waiting for PR auto-review status from the server.');
  assert.equal(prStatusPlaceholder(undefined), 'Waiting for PR auto-review status from the server.');
});

test('prStatusPlaceholder: reports a misconfigured lane with the reason', () => {
  assert.equal(
    prStatusPlaceholder({ configured: false, reason: 'telegram missing' }),
    'PR auto-review is misconfigured: telegram missing. Open Settings and its PR Review tab.',
  );
});

test('prStatusPlaceholder: reports a disabled lane without a reason', () => {
  assert.equal(
    prStatusPlaceholder({ configured: false, reason: '' }),
    'PR auto-review is off. Open Settings and its PR Review tab to switch it on.',
  );
});

test('prStatusPlaceholder: reports configured or legacy statuses as waiting for first poll', () => {
  assert.equal(prStatusPlaceholder({ configured: true }), 'PR auto-review is on. Waiting for the first poll.');
  assert.equal(prStatusPlaceholder({}), 'PR auto-review is on. Waiting for the first poll.');
});

test('severityFor: crit for error, warn for changes and conflicts, info for checks, ok for merged', () => {
  assert.equal(severityFor('error'), 'crit');
  assert.equal(severityFor('done'), 'warn');
  assert.equal(severityFor('changes-requested'), 'warn');
  assert.equal(severityFor('conflicting'), 'warn');
  assert.equal(severityFor('awaiting-checks'), 'info');
  assert.equal(severityFor('in-review'), 'info');
  assert.equal(severityFor('merged'), 'ok');
});

test('severityFor: pingedError outranks the phase', () => {
  assert.equal(severityFor('merged', { pingedError: true }), 'crit');
  assert.equal(severityFor('awaiting-checks', { pingedError: true }), 'crit');
});

test('severityFor: an unknown phase is dim, or info while a review is in flight', () => {
  assert.equal(severityFor('sideways'), 'dim');
  assert.equal(severityFor('sideways', { inFlight: true }), 'info');
  assert.equal(severityFor('merged', { inFlight: true }), 'ok');
});

test('severityFor: a null phase is the pending state, dim even while in flight', () => {
  assert.equal(severityFor(null), 'dim');
  assert.equal(severityFor(undefined), 'dim');
  assert.equal(severityFor('pending'), 'dim');
  assert.equal(severityFor(null, { inFlight: true }), 'dim');
  assert.equal(severityFor(null, { pingedError: true }), 'crit');
});

test('normalizePhase: a null or absent phase reads as pending, anything else is untouched', () => {
  assert.equal(normalizePhase(null), 'pending');
  assert.equal(normalizePhase(undefined), 'pending');
  assert.equal(normalizePhase('merged'), 'merged');
  assert.equal(normalizePhase('sideways'), 'sideways');
});

test('sortPrsByAttention: orders error, changes, conflicts, awaiting checks, pending, merged', () => {
  const prs = [
    { title: 'merged', phase: 'merged' },
    { title: 'unreviewed', phase: null },
    { title: 'checks', phase: 'awaiting-checks' },
    { title: 'conflict', phase: 'conflicting' },
    { title: 'changes', phase: 'done' },
    { title: 'broken', phase: 'error' },
  ];
  assert.deepEqual(labelsOf(sortPrsByAttention(prs)), ['broken', 'changes', 'conflict', 'checks', 'unreviewed', 'merged']);
});

test('sortPrsByAttention: pingedError ranks with the errors regardless of phase', () => {
  const prs = [
    { title: 'calm', phase: 'awaiting-checks' },
    { title: 'pinged', phase: 'merged', pingedError: true },
  ];
  assert.deepEqual(labelsOf(sortPrsByAttention(prs)), ['pinged', 'calm']);
});

test('sortPrsByAttention: same phase puts the newest PR number first', () => {
  const prs = [
    { title: 'old', phase: 'error', number: 4 },
    { title: 'new', phase: 'error', number: 91 },
    { title: 'mid', phase: 'error', number: 40 },
  ];
  assert.deepEqual(labelsOf(sortPrsByAttention(prs)), ['new', 'mid', 'old']);
});

test('sortPrsByAttention: fully tied rows keep the order the backend sent', () => {
  const prs = [
    { title: 'first', phase: 'done', number: 7 },
    { title: 'second', phase: 'done', number: 7 },
    { title: 'third', phase: 'done', number: 7 },
  ];
  assert.deepEqual(labelsOf(sortPrsByAttention(prs)), ['first', 'second', 'third']);
});

test('sortPrsByAttention: an unknown phase sorts last rather than jumping the queue', () => {
  const prs = [
    { title: 'weird', phase: 'sideways' },
    { title: 'merged', phase: 'merged' },
    { title: 'broken', phase: 'error' },
  ];
  assert.deepEqual(labelsOf(sortPrsByAttention(prs)), ['broken', 'merged', 'weird']);
});

test('sortPrsByAttention: does not mutate the input array', () => {
  const prs = [{ title: 'merged', phase: 'merged' }, { title: 'broken', phase: 'error' }];
  const sorted = sortPrsByAttention(prs);
  assert.deepEqual(labelsOf(prs), ['merged', 'broken']);
  assert.deepEqual(labelsOf(sorted), ['broken', 'merged']);
});

test('sortPrsByAttention: a non-array input returns an empty array', () => {
  assert.deepEqual(sortPrsByAttention(undefined), []);
  assert.deepEqual(sortPrsByAttention(null), []);
});

test('summarizePrs: counts open PRs, in-flight reviews and errors', () => {
  const prs = [
    { title: 'a', phase: 'error' },
    { title: 'b', phase: 'awaiting-checks', inFlight: true },
    { title: 'c', phase: 'merged', pingedError: true },
    { title: 'd', phase: 'done' },
  ];
  assert.deepEqual(summarizePrs(prs), { open: 4, inReview: 1, errors: 2 });
});

test('summarizePrs: a non-array or empty input summarizes to zeroes', () => {
  assert.deepEqual(summarizePrs([]), { open: 0, inReview: 0, errors: 0 });
  assert.deepEqual(summarizePrs(undefined), { open: 0, inReview: 0, errors: 0 });
  assert.deepEqual(summarizePrs(null), { open: 0, inReview: 0, errors: 0 });
});

test('summarizePrs: malformed entries never throw', () => {
  assert.deepEqual(summarizePrs([null, undefined, {}]), { open: 3, inReview: 0, errors: 0 });
});

test('prNeedsAction: error, changes-requested and conflicting phases need the operator', () => {
  assert.equal(prNeedsAction({ phase: 'error' }), true);
  assert.equal(prNeedsAction({ phase: 'done' }), true);
  assert.equal(prNeedsAction({ phase: 'changes-requested' }), true);
  assert.equal(prNeedsAction({ phase: 'conflicting' }), true);
});

test('prNeedsAction: healthy in-flight and settled phases do not', () => {
  assert.equal(prNeedsAction({ phase: 'resolving-conflicts' }), false);
  assert.equal(prNeedsAction({ phase: 'awaiting-checks' }), false);
  assert.equal(prNeedsAction({ phase: 'in-review', inFlight: true }), false);
  assert.equal(prNeedsAction({ phase: 'merged' }), false);
  assert.equal(prNeedsAction({ phase: null }), false);
  assert.equal(prNeedsAction({}), false);
  assert.equal(prNeedsAction(null), false);
});

test('prNeedsAction: pingedError outranks an otherwise calm phase', () => {
  assert.equal(prNeedsAction({ phase: 'awaiting-checks', pingedError: true }), true);
});

test('prNeedsAction: a resolved wasConflicting flag is history, not an open ask', () => {
  assert.equal(prNeedsAction({ phase: 'awaiting-checks', wasConflicting: true }), false);
  assert.equal(prNeedsAction({ phase: 'merged', wasConflicting: true }), false);
});

test('prNeedsAction: every PR the tab dot counts as an error also needs action', () => {
  const prs = [
    { phase: 'error' },
    { phase: 'merged', pingedError: true },
    { phase: 'awaiting-checks' },
  ];
  assert.equal(summarizePrs(prs).errors, 2);
  assert.equal(prs.filter((pr) => prNeedsAction(pr)).length, 2);
});

test('prAttentionSignature: names each broken PR by repo, number and phase', () => {
  const snapshot = { projects: [{ repoSlug: 'me/app', prs: [
    { number: 7, phase: 'error' },
    { number: 8, phase: 'merged', pingedError: true },
    { number: 9, phase: 'awaiting-checks' },
  ] }] };
  assert.equal(prAttentionSignature(snapshot), 'me/app#7:error|me/app#8:merged');
});

test('prAttentionSignature: a phase change on the same PR is a different signature', () => {
  const withPhase = (phase: string) => prAttentionSignature({ projects: [{ repoSlug: 'me/app', prs: [{ number: 7, phase, pingedError: true }] }] });
  assert.notEqual(withPhase('error'), withPhase('conflicting'));
});

test('prAttentionSignature: healthy PRs and absent feeds are the empty signature, never a throw', () => {
  assert.equal(prAttentionSignature({ projects: [{ repoSlug: 'me/app', prs: [{ number: 7, phase: 'merged' }] }] }), '');
  assert.equal(prAttentionSignature(null), '');
  assert.equal(prAttentionSignature({}), '');
  assert.equal(prAttentionSignature({ projects: [null, { prs: null }] }), '');
});

test('prAttentionSignature: the same broken PRs in a different order are the same signature', () => {
  const rows = [{ number: 7, phase: 'error' }, { number: 8, phase: 'error' }];
  const one = prAttentionSignature({ projects: [{ repoSlug: 'me/app', prs: rows }] });
  const other = prAttentionSignature({ projects: [{ repoSlug: 'me/app', prs: [...rows].reverse() }] });
  assert.equal(one, other);
});

test('prAttentionSignature: an unlabelled project falls back to its id, a numberless PR to a placeholder', () => {
  assert.equal(prAttentionSignature({ projects: [{ projectId: 'p1', prs: [{ phase: 'error' }] }] }), 'p1#?:error');
});

test('prAttentionSignature: every PR the tab dot counts as an error is named', () => {
  const prs = [{ number: 1, phase: 'error' }, { number: 2, pingedError: true }, { number: 3, phase: 'in-review' }];
  const signature = prAttentionSignature({ projects: [{ repoSlug: 'me/app', prs }] });
  assert.equal(signature.split('|').length, summarizePrs(prs).errors);
});

test('phaseLabel: known phases read in words, an unknown one keeps its raw string', () => {
  assert.deepEqual(phaseLabel('done'), { label: 'changes requested', known: true });
  assert.deepEqual(phaseLabel(null), { label: 'pending', known: true });
  assert.deepEqual(phaseLabel('sideways'), { label: 'sideways', known: false });
});
