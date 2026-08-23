'use strict';

// The rr-cache listener and the cooldown rule it drives (2026-08 review, section 4, first in line for
// that section because it serves the unattended-integration priority directly).
//
// The limitation it closes: the auto-rebase conflict cooldown is keyed on a sha pair and expires when
// one of them moves, so a SIBLING session resolving the same conflict - which is exactly what would
// let this worktree finish, via the shared rerere cache - clears nothing until a sha happens to move.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRerereWatcher, RR_CACHE_DIR } = require('../detection/rerere-watch');
const { decideRerereCooldownClear } = require('../session/core/rebase-gate');

function tempGitDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-rerere-'));
}

// fs.watch is lossy and platform-timed, so the assertions poll for the call rather than sleeping a
// fixed amount and hoping.
async function waitForCalls(counter, expected, deadlineMs = 5000) {
  const deadline = Date.now() + deadlineMs;
  while (counter.count < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return counter.count;
}

test('a resolution recorded in an existing rr-cache fires the listener', async (t) => {
  const gitDir = tempGitDir();
  t.after(() => fs.rmSync(gitDir, { recursive: true, force: true }));
  const cacheDir = path.join(gitDir, RR_CACHE_DIR);
  fs.mkdirSync(cacheDir);

  const counter = { count: 0 };
  const watcher = createRerereWatcher({ commonGitDir: gitDir, onChange: () => { counter.count += 1; }, debounceMs: 20 });
  t.after(() => watcher.stop());
  assert.equal(watcher.start(), true);

  // What git does when rerere records a resolution: a new hash directory under rr-cache.
  fs.mkdirSync(path.join(cacheDir, 'a1b2c3'));
  assert.equal(await waitForCalls(counter, 1), 1);
});

// git creates rr-cache lazily on the FIRST recorded resolution, so a repo that has never recorded one
// has nothing to watch yet - and that first resolution is the one most worth reacting to.
test('a repo with no rr-cache yet watches for it appearing and upgrades itself', async (t) => {
  const gitDir = tempGitDir();
  t.after(() => fs.rmSync(gitDir, { recursive: true, force: true }));

  const counter = { count: 0 };
  const watcher = createRerereWatcher({ commonGitDir: gitDir, onChange: () => { counter.count += 1; }, debounceMs: 20 });
  t.after(() => watcher.stop());
  assert.equal(watcher.start(), true);

  const cacheDir = path.join(gitDir, RR_CACHE_DIR);
  fs.mkdirSync(cacheDir);
  assert.equal(await waitForCalls(counter, 1), 1, 'rr-cache appearing IS the first recorded resolution');

  fs.mkdirSync(path.join(cacheDir, 'd4e5f6'));
  assert.equal(await waitForCalls(counter, 2), 2, 'and the watch moved onto the cache itself');
});

test('a missing common gitdir declines rather than throwing', () => {
  const watcher = createRerereWatcher({ commonGitDir: null, onChange: () => {} });
  assert.equal(watcher.start(), false);
  assert.doesNotThrow(() => watcher.stop());
});

test('stop is idempotent and survives a watcher that never started', () => {
  const watcher = createRerereWatcher({ commonGitDir: path.join(os.tmpdir(), 'nope-does-not-exist'), onChange: () => {} });
  watcher.stop();
  assert.doesNotThrow(() => watcher.stop());
});

// The rule the watcher drives.
test('a recorded resolution clears a live cooldown and nothing else', () => {
  assert.deepEqual(
    decideRerereCooldownClear({ enabled: true, hasCooldown: true, teardownPending: false }),
    { clear: true, reason: 'rerere-recorded' }
  );
  assert.deepEqual(
    decideRerereCooldownClear({ enabled: true, hasCooldown: false, teardownPending: false }),
    { clear: false, reason: 'no-cooldown' },
    'a resolution recorded while this session was never blocked is not news'
  );
  assert.deepEqual(
    decideRerereCooldownClear({ enabled: false, hasCooldown: true, teardownPending: false }),
    { clear: false, reason: 'disabled' }
  );
  assert.deepEqual(
    decideRerereCooldownClear({ enabled: true, hasCooldown: true, teardownPending: true }),
    { clear: false, reason: 'teardown' }
  );
});
