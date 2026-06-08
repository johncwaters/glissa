'use strict';

// detection/integration-ref-watch.js - the fs.watch accelerator over an integration branch's reflog
// (logs/refs/heads/<branch>) in a shared commonGitDir. Driven against a real temp reflog dir so the
// debounced, leaf-filtered fs.watch round-trip is real. This is the event-driven replacement for the
// old 10s poll's "did the integration branch move out from under this worktree" job.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createIntegrationRefWatcher } = require('../detection/integration-ref-watch');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake commonGitDir with a reflog dir we can append to, to drive fs.watch.
function fakeCommonGitDir(branches = ['develop']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-irw-'));
  const logsHeads = path.join(dir, 'logs', 'refs', 'heads');
  fs.mkdirSync(logsHeads, { recursive: true });
  for (const b of branches) {
    const p = path.join(logsHeads, b);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '0000 init\n', 'utf8');
  }
  const append = (b, line) => fs.appendFileSync(path.join(logsHeads, b), line + '\n', 'utf8');
  return { dir, append, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('fires (debounced, coalesced) when the integration branch reflog is appended', async () => {
  const fx = fakeCommonGitDir(['develop']);
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: fx.dir, branch: 'develop', onChange: () => { calls++; }, debounceMs: 50 });
  try {
    assert.equal(w.start(), true, 'started over a real reflog dir');
    assert.equal(w.active, true);
    // A burst (a merge appends a couple of reflog lines) within the debounce window.
    for (let i = 0; i < 4; i++) fx.append('develop', `move ${i}`);
    await wait(300);
    assert.equal(calls, 1, 'the burst coalesced into exactly one onChange');

    fx.append('develop', 'later move');
    await wait(300);
    assert.equal(calls, 2, 'a subsequent move fires again');
  } finally {
    w.stop();
    fx.cleanup();
  }
});

test('ignores a sibling branch reflog (leaf filter)', async () => {
  const fx = fakeCommonGitDir(['develop', 'feature']);
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: fx.dir, branch: 'develop', onChange: () => { calls++; }, debounceMs: 50 });
  try {
    w.start();
    fx.append('feature', 'a sibling commit'); // not our integration branch
    await wait(250);
    assert.equal(calls, 0, 'a sibling branch move does not fire the integration watcher');
    fx.append('develop', 'our move');
    await wait(250);
    assert.equal(calls, 1, 'our branch move does fire');
  } finally {
    w.stop();
    fx.cleanup();
  }
});

test('handles a nested integration branch (release/x)', async () => {
  const fx = fakeCommonGitDir(['release/x']);
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: fx.dir, branch: 'release/x', onChange: () => { calls++; }, debounceMs: 50 });
  try {
    assert.equal(w.start(), true, 'watches the nested reflog parent dir');
    fx.append('release/x', 'move');
    await wait(250);
    assert.equal(calls, 1);
  } finally {
    w.stop();
    fx.cleanup();
  }
});

test('start() declines when the reflog dir does not exist yet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-irw-none-'));
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: dir, branch: 'develop', onChange: () => { calls++; }, debounceMs: 50 });
  try {
    assert.equal(w.start(), false, 'no logs/refs/heads dir -> start() declines, leans on the floor');
    assert.equal(w.active, false);
    assert.doesNotThrow(() => w.stop());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stop() halts the watcher and start() after stop stays inert', async () => {
  const fx = fakeCommonGitDir(['develop']);
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: fx.dir, branch: 'develop', onChange: () => { calls++; }, debounceMs: 50 });
  try {
    w.start();
    w.stop();
    assert.equal(w.active, false);
    fx.append('develop', 'after stop');
    await wait(250);
    assert.equal(calls, 0, 'no onChange after stop');
    assert.equal(w.start(), false, 'single-use: start() after stop stays inert');
  } finally {
    w.stop();
    fx.cleanup();
  }
});
