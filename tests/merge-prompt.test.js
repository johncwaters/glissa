'use strict';

// Unit tests for the pure manual-merge handoff prompt builder (session-core/merge-prompt.js).
// Locks the content contract the parked-merge handoff relies on: the prompt names the branch, the
// integration target, the conflicting files, and the rebase-then-resolve steps, and degrades safely.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMergePrompt } = require('../session-core/merge-prompt');

test('buildMergePrompt (rebase-conflict): names branch, target, conflicting files, and the rebase steps', () => {
  const p = buildMergePrompt({
    branch: 'glissa/session/abc',
    target: 'develop',
    reason: 'rebase-conflict',
    conflicts: ['src/a.js', 'src/b.js'],
    worktreeDir: '/wt/abc',
  });
  assert.match(p, /manual merge/i);
  assert.match(p, /glissa\/session\/abc/);
  assert.match(p, /develop/);
  assert.match(p, /overlap/i); // the rebase-conflict "why"
  assert.ok(p.includes('Conflicting files:'));
  assert.ok(p.includes('- src/a.js') && p.includes('- src/b.js'));
  assert.ok(p.includes('git rebase develop'));
  assert.ok(p.includes('git rebase --continue'));
  assert.ok(p.includes('/wt/abc'));
});

test('buildMergePrompt (not-fast-forward): no conflicting-files section, explains the advance', () => {
  const p = buildMergePrompt({ branch: 'b', target: 'develop', reason: 'not-fast-forward', conflicts: [] });
  assert.equal(p.includes('Conflicting files:'), false);
  assert.match(p, /advanced/i);
  assert.ok(p.includes('git rebase develop'));
});

test('buildMergePrompt: an unknown reason falls back without inventing detail', () => {
  const p = buildMergePrompt({ branch: 'b', target: 'develop', reason: 'weird-thing', conflicts: [] });
  assert.match(p, /could not complete automatically \(weird-thing\)/);
});

test('buildMergePrompt: missing branch/target/worktree use safe generic phrasing', () => {
  const p = buildMergePrompt({});
  assert.ok(p.includes('the integration branch'));
  assert.ok(p.includes("this session's branch"));
  assert.equal(/from this worktree \(\)/i.test(p), false); // no empty "()" when worktreeDir is absent
});
