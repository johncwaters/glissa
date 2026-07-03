'use strict';

// Pure review-gate demotion matrix (session-core/merge-gate.js), extracted from
// Session.checkWorktreeChange / Session.getDiff. The Session-level wiring (emit
// ordering, dedup interplay) stays covered by sessions-worktree tests; this pins
// the decision table itself.

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideSignatureDemotion, decideDiffSelfHeal } = require('../session-core/merge-gate');

function sig(over = {}) {
  return { dirty: false, ahead: '0', behind: '0', rebaseInProgress: false, ...over };
}

test('signature demotion: reviewable gate over a clean, un-ahead worktree heals to none', () => {
  for (const status of ['pending-review', 'parked']) {
    assert.equal(decideSignatureDemotion(status, sig()), 'none', status);
    assert.equal(decideSignatureDemotion(status, sig({ ahead: '' })), 'none', `${status}, empty ahead counts as zero`);
  }
});

test('signature demotion: dirty or ahead worktree keeps a pending-review gate', () => {
  assert.equal(decideSignatureDemotion('pending-review', sig({ dirty: true })), null);
  assert.equal(decideSignatureDemotion('pending-review', sig({ ahead: '2' })), null);
});

test('signature demotion: parked becomes mergeable again only when clean, ahead, on top of the target, and not mid-rebase', () => {
  assert.equal(decideSignatureDemotion('parked', sig({ ahead: '2' })), 'pending-review');
  assert.equal(decideSignatureDemotion('parked', sig({ ahead: '2', behind: '' })), 'pending-review', 'empty behind counts as zero');
  assert.equal(decideSignatureDemotion('parked', sig({ ahead: '2', dirty: true })), null, 'dirty blocks');
  assert.equal(decideSignatureDemotion('parked', sig({ ahead: '2', behind: '1' })), null, 'behind the merge target blocks');
  assert.equal(decideSignatureDemotion('parked', sig({ ahead: '2', rebaseInProgress: true })), null, 'paused rebase blocks');
});

test('signature demotion: non-reviewable statuses never demote', () => {
  for (const status of ['none', 'merging', 'merged']) {
    assert.equal(decideSignatureDemotion(status, sig()), null, status);
    assert.equal(decideSignatureDemotion(status, sig({ ahead: '2' })), null, status);
  }
});

test('diff self-heal: reviewable gate over an empty diff drops to none', () => {
  for (const status of ['pending-review', 'parked']) {
    assert.equal(decideDiffSelfHeal(status, '', ''), 'none', status);
    assert.equal(decideDiffSelfHeal(status, ' \n', '\t'), 'none', `${status}, whitespace-only diffs are empty`);
  }
});

test('diff self-heal: any remaining diff keeps the gate', () => {
  assert.equal(decideDiffSelfHeal('pending-review', 'diff --git a b', ''), null);
  assert.equal(decideDiffSelfHeal('pending-review', '', 'diff --git a b'), null);
});

test('diff self-heal: non-reviewable statuses never heal', () => {
  for (const status of ['none', 'merging', 'merged']) {
    assert.equal(decideDiffSelfHeal(status, '', ''), null, status);
  }
});
