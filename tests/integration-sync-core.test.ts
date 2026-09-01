import test from 'node:test';
import assert from 'node:assert/strict';

import { decideIntegrationSync, classifyRefusedIntegrationSync } from '../server/core/integration-sync-core.ts';

test('integration sync has no remote branch to follow', () => {
  assert.deepEqual(
    decideIntegrationSync({ localSha: 'local', remoteSha: null, isAncestor: false, checkedOut: false }),
    { action: 'none', outcome: 'no-remote' },
  );
});

test('integration sync leaves a missing local branch for worktree creation', () => {
  assert.deepEqual(
    decideIntegrationSync({ localSha: null, remoteSha: 'remote', isAncestor: false, checkedOut: false }),
    { action: 'none', outcome: 'missing' },
  );
});

test('integration sync detects an up-to-date branch', () => {
  assert.deepEqual(
    decideIntegrationSync({ localSha: 'same', remoteSha: 'same', isAncestor: true, checkedOut: false }),
    { action: 'none', outcome: 'up-to-date' },
  );
});

test('integration sync never moves a diverged branch', () => {
  assert.deepEqual(
    decideIntegrationSync({ localSha: 'local', remoteSha: 'remote', isAncestor: false, checkedOut: false }),
    { action: 'none', outcome: 'diverged' },
  );
});

test('integration sync refuses a fast-forward while the branch is checked out', () => {
  assert.deepEqual(
    decideIntegrationSync({ localSha: 'local', remoteSha: 'remote', isAncestor: true, checkedOut: true }),
    { action: 'none', outcome: 'checked-out' },
  );
});

test('integration sync fast-forwards an unchecked strict ancestor', () => {
  assert.deepEqual(
    decideIntegrationSync({ localSha: 'local', remoteSha: 'remote', isAncestor: true, checkedOut: false }),
    { action: 'update', outcome: 'updated' },
  );
});

// Ancestry is tri-state on the pre-update side too, and for the same reason: only a probe that RAN and
// said no earns 'diverged'. A probe that could not run says nothing about the branch, so it must not
// harden into a claim that the operator's integration branch forked.
test('an ancestry probe that could not run is never reported as diverged', () => {
  for (const isAncestor of [null, undefined]) {
    assert.deepEqual(
      decideIntegrationSync({ localSha: 'local', remoteSha: 'remote', isAncestor, checkedOut: false }),
      { action: 'none', outcome: 'update-failed' },
      `${isAncestor} is unknown, not a fork`,
    );
  }
});

test('an unknown ancestry never authorizes the fast-forward either', () => {
  assert.equal(
    decideIntegrationSync({ localSha: 'local', remoteSha: 'remote', isAncestor: null, checkedOut: true }).action,
    'none',
  );
});

test('a successful negative probe is still the one thing that means diverged', () => {
  assert.deepEqual(
    decideIntegrationSync({ localSha: 'local', remoteSha: 'remote', isAncestor: false, checkedOut: true }),
    { action: 'none', outcome: 'diverged' },
  );
});

// The post-refusal read. git refuses a fast-forward for several different reasons and names which only
// in prose, so the outcome comes from the repo's state afterwards. The guard order matches
// decideIntegrationSync above, or one repo shape would get two different labels depending on whether the
// pre-check or the refusal reached it.
test('a refusal that already reached the remote tip is up-to-date, not a failure', () => {
  assert.deepEqual(
    classifyRefusedIntegrationSync({ currentSha: 'same', remoteSha: 'same', isAncestor: true, checkedOut: false }),
    { outcome: 'up-to-date' },
  );
});

test('a refusal on a branch that really forked is diverged', () => {
  assert.deepEqual(
    classifyRefusedIntegrationSync({ currentSha: 'local', remoteSha: 'remote', isAncestor: false, checkedOut: false }),
    { outcome: 'diverged' },
  );
});

test('a refusal on a still-fast-forwardable branch someone checked out is checked-out', () => {
  assert.deepEqual(
    classifyRefusedIntegrationSync({ currentSha: 'local', remoteSha: 'remote', isAncestor: true, checkedOut: true }),
    { outcome: 'checked-out' },
  );
});

// The reason this classifier exists: a stale ref lock or a read-only ref store refuses a fast-forward
// that is still perfectly legal, and calling that 'diverged' tells the operator their integration branch
// forked when nothing of the sort happened.
test('a refusal with the fast-forward still legal is an operational update-failed', () => {
  assert.deepEqual(
    classifyRefusedIntegrationSync({ currentSha: 'local', remoteSha: 'remote', isAncestor: true, checkedOut: false }),
    { outcome: 'update-failed' },
  );
});

// Ancestry is tri-state: an unreadable repo answers null, and an unknown must never harden into a claim
// about history. It falls through to the operational outcome, which is retried, not to diverged.
test('an unknown ancestry is never reported as diverged', () => {
  assert.deepEqual(
    classifyRefusedIntegrationSync({ currentSha: 'local', remoteSha: 'remote', isAncestor: null, checkedOut: false }),
    { outcome: 'update-failed' },
  );
  assert.deepEqual(
    classifyRefusedIntegrationSync({ currentSha: 'local', remoteSha: 'remote', isAncestor: null, checkedOut: true }),
    { outcome: 'checked-out' },
  );
});

test('an unreadable local ref cannot masquerade as up-to-date against a missing remote', () => {
  assert.deepEqual(
    classifyRefusedIntegrationSync({ currentSha: null, remoteSha: null, isAncestor: null, checkedOut: false }),
    { outcome: 'update-failed' },
  );
});
