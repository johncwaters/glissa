import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRerereWatcher, RR_CACHE_DIR } from '../detection/rerere-watch.ts';
import { decideRerereCooldownClear } from '../session/core/rebase-gate.ts';

function tempGitDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-rerere-'));
}

async function waitForCalls(counter: { count: number }, expected: number, deadlineMs = 5000) {
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

  fs.mkdirSync(path.join(cacheDir, 'a1b2c3'));
  assert.equal(await waitForCalls(counter, 1), 1);
});

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

test('an outer event that fires before rr-cache exists does not disarm the watch', async (t) => {
  const gitDir = tempGitDir();
  t.after(() => fs.rmSync(gitDir, { recursive: true, force: true }));

  const counter = { count: 0 };
  const watcher = createRerereWatcher({ commonGitDir: gitDir, onChange: () => { counter.count += 1; }, debounceMs: 20 });
  t.after(() => watcher.stop());
  assert.equal(watcher.start(), true);

  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(counter.count, 0, 'nothing to hand over to, so nothing is reported');

  const cacheDir = path.join(gitDir, RR_CACHE_DIR);
  fs.mkdirSync(cacheDir);
  assert.equal(await waitForCalls(counter, 1), 1, 'the watch was still armed');

  fs.mkdirSync(path.join(cacheDir, 'a1b2c3'));
  assert.equal(await waitForCalls(counter, 2), 2, 'and the handover to the cache itself happened');
});
