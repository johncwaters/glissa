'use strict';

// detection/integration-watcher-pool.js - the ref-counted pool that keeps one integration-ref watcher
// per (commonGitDir, branch) and fans a branch move out to sibling worktree sessions. Driven with fake
// watchers + a fake session registry so the lifecycle (ref-count, stop-on-last-release, fan-out filter,
// kill-switch, shutdown) is unit-tested without a real backend or fs.watch.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIntegrationWatcherPool } = require('../detection/integration-watcher-pool');

function harness(opts = {}) {
  const created = []; // each fake watcher: { commonGitDir, branch, onChange, started, stopped }
  const sessions = new Map();
  const rechecked = [];
  const createWatcher = ({ commonGitDir, branch, onChange }) => {
    const w = {
      commonGitDir, branch, onChange, started: 0, stopped: 0,
      start() { this.started++; },
      stop() { this.stopped++; },
    };
    created.push(w);
    return w;
  };
  const pool = createIntegrationWatcherPool({
    sessions,
    createWatcher,
    recheck: (s) => rechecked.push(s.id),
    isEnabled: opts.isEnabled || (() => true),
  });
  return { pool, created, sessions, rechecked };
}

const mkSess = (id, commonGitDir, branch, worktreeDir = `/wt/${id}`) =>
  ({ id, commonGitDir, integrationBranch: branch, worktreeDir });

test('ensure creates one watcher per repo+branch and shares it across sessions (ref-count)', () => {
  const { pool, created } = harness();
  pool.ensure(mkSess('a', '/repo/.git', 'develop'));
  pool.ensure(mkSess('b', '/repo/.git', 'develop')); // same key -> joins the existing watcher
  assert.equal(pool.size, 1, 'one watcher for the shared repo+branch');
  assert.equal(created.length, 1, 'createWatcher called once');
  assert.equal(created[0].started, 1, 'started exactly once');
});

test('a different integration branch in the same repo gets its own watcher', () => {
  const { pool } = harness();
  pool.ensure(mkSess('a', '/repo/.git', 'develop'));
  pool.ensure(mkSess('b', '/repo/.git', 'main'));
  assert.equal(pool.size, 2);
});

test('release stops the watcher only when the last holder leaves', () => {
  const { pool, created } = harness();
  const a = mkSess('a', '/repo/.git', 'develop');
  const b = mkSess('b', '/repo/.git', 'develop');
  pool.ensure(a); pool.ensure(b);
  pool.release(a);
  assert.equal(pool.size, 1, 'still held by b');
  assert.equal(created[0].stopped, 0, 'not stopped while a holder remains');
  pool.release(b);
  assert.equal(pool.size, 0);
  assert.equal(created[0].stopped, 1, 'stopped once the last holder releases');
});

test('release works by session id even after the session cleared its commonGitDir (teardown order)', () => {
  const { pool, created } = harness();
  const a = mkSess('a', '/repo/.git', 'develop');
  pool.ensure(a);
  a.commonGitDir = null; // a discard/merge nulls this BEFORE release in the real teardown
  pool.release(a);
  assert.equal(pool.size, 0);
  assert.equal(created[0].stopped, 1);
});

test('a branch move re-checks only matching live-worktree siblings', () => {
  const { pool, created, sessions, rechecked } = harness();
  const a = mkSess('a', '/repo/.git', 'develop');
  const b = mkSess('b', '/repo/.git', 'develop');
  const other = mkSess('c', '/other/.git', 'develop');     // different repo
  const noWt = mkSess('d', '/repo/.git', 'develop', null); // same repo, but no worktree
  for (const s of [a, b, other, noWt]) sessions.set(s.id, s);
  pool.ensure(a);

  created[0].onChange(); // simulate the reflog moving

  assert.deepEqual(rechecked, ['a', 'b'], 'only same-commonGitDir sessions WITH a worktree are re-checked');
});

test('isEnabled() false makes ensure a no-op (kill-switch)', () => {
  const { pool, created } = harness({ isEnabled: () => false });
  pool.ensure(mkSess('a', '/repo/.git', 'develop'));
  assert.equal(pool.size, 0);
  assert.equal(created.length, 0);
});

test('ensure ignores a session with no commonGitDir or no integration branch', () => {
  const { pool } = harness();
  pool.ensure(mkSess('a', null, 'develop'));
  pool.ensure(mkSess('b', '/repo/.git', null));
  assert.equal(pool.size, 0);
});

test('stopAll stops every watcher and clears the pool', () => {
  const { pool, created } = harness();
  pool.ensure(mkSess('a', '/repo/.git', 'develop'));
  pool.ensure(mkSess('b', '/repo/.git', 'main'));
  pool.stopAll();
  assert.equal(pool.size, 0);
  assert.equal(created.length, 2);
  assert.ok(created.every((w) => w.stopped === 1), 'each watcher stopped exactly once');
});
