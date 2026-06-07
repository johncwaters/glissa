'use strict';

// detection/worktree-watch.js - the fs.watch accelerator over a linked worktree's
// gitdir. resolveWorktreeGitDir is exercised against hand-written `.git` pointer
// files (the same fixture style as worktree-detection.test.js); the watcher itself
// is driven against a real temp gitdir so the debounced fs.watch round-trip is real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorktreeWatcher, resolveWorktreeGitDir } = require('../detection/worktree-watch');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- resolveWorktreeGitDir ---

test('resolveWorktreeGitDir resolves an absolute gitdir pointer with a worktrees/ segment', () => {
  const wt = tmpdir('glissa-ww-wt-');
  const gitDir = path.join(tmpdir('glissa-ww-git-'), 'worktrees', 'feature');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`, 'utf8');
  try {
    assert.equal(resolveWorktreeGitDir(wt), path.resolve(gitDir));
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(path.dirname(path.dirname(gitDir)), { recursive: true, force: true });
  }
});

test('resolveWorktreeGitDir resolves a relative pointer against the worktree dir', () => {
  const base = tmpdir('glissa-ww-rel-');
  const wt = path.join(base, 'wt');
  fs.mkdirSync(wt);
  const gitDir = path.join(base, '.git', 'worktrees', 'feature');
  fs.mkdirSync(gitDir, { recursive: true });
  // No leading slash: a Git 2.48+ --relative-paths pointer.
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../.git/worktrees/feature\n', 'utf8');
  try {
    assert.equal(resolveWorktreeGitDir(wt), path.resolve(gitDir));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveWorktreeGitDir returns null for a normal checkout, a submodule, and a missing dir', () => {
  // Normal checkout: .git is a directory.
  const repo = tmpdir('glissa-ww-repo-');
  fs.mkdirSync(path.join(repo, '.git'));
  // Submodule: .git points at modules/, not worktrees/.
  const sub = tmpdir('glissa-ww-sub-');
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: /repo/.git/modules/x\n', 'utf8');
  try {
    assert.equal(resolveWorktreeGitDir(repo), null);
    assert.equal(resolveWorktreeGitDir(sub), null);
    assert.equal(resolveWorktreeGitDir(path.join(repo, 'nope')), null);
    assert.equal(resolveWorktreeGitDir(null), null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sub, { recursive: true, force: true });
  }
});

test('resolveWorktreeGitDir returns null when the pointer target does not exist', () => {
  const wt = tmpdir('glissa-ww-gone-');
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /no/such/.git/worktrees/x\n', 'utf8');
  try {
    assert.equal(resolveWorktreeGitDir(wt), null);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

// --- the watcher ---

// Build a fake linked worktree: a worktree dir whose `.git` file points at a real,
// existing gitdir we can write into to drive fs.watch.
function fakeLinkedWorktree() {
  const base = tmpdir('glissa-ww-live-');
  const wt = path.join(base, 'wt');
  fs.mkdirSync(wt);
  const gitDir = path.join(base, '.git', 'worktrees', 'feature');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`, 'utf8');
  fs.writeFileSync(path.join(gitDir, 'index'), 'v1', 'utf8'); // a direct child to touch
  return { base, wt, gitDir, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('the watcher fires (debounced, coalesced) when the gitdir changes', async () => {
  const fx = fakeLinkedWorktree();
  let calls = 0;
  const w = createWorktreeWatcher({ worktreeDir: fx.wt, onChange: () => { calls++; }, debounceMs: 50 });
  try {
    assert.equal(w.start(), true, 'started over a real linked-worktree gitdir');
    assert.equal(w.active, true);
    // A burst of writes (as one `git commit` would produce) within the debounce window.
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(fx.gitDir, 'index'), `v${i + 2}`, 'utf8');
    await wait(300);
    assert.equal(calls, 1, 'the write burst coalesced into exactly one onChange');

    // A later, separate change fires again.
    fs.writeFileSync(path.join(fx.gitDir, 'COMMIT_EDITMSG'), 'msg', 'utf8');
    await wait(300);
    assert.equal(calls, 2, 'a subsequent change fires a second onChange');
  } finally {
    w.stop();
    fx.cleanup();
  }
});

test('stop() halts the watcher: no onChange after stop', async () => {
  const fx = fakeLinkedWorktree();
  let calls = 0;
  const w = createWorktreeWatcher({ worktreeDir: fx.wt, onChange: () => { calls++; }, debounceMs: 50 });
  try {
    w.start();
    w.stop();
    assert.equal(w.active, false);
    fs.writeFileSync(path.join(fx.gitDir, 'index'), 'after-stop', 'utf8');
    await wait(300);
    assert.equal(calls, 0, 'no onChange fires once stopped');
    // start() after stop() stays inert (the watcher is single-use).
    assert.equal(w.start(), false);
  } finally {
    w.stop();
    fx.cleanup();
  }
});

test('start() is a safe no-op for a non-worktree dir (in-place session)', async () => {
  const repo = tmpdir('glissa-ww-inplace-');
  fs.mkdirSync(path.join(repo, '.git')); // a normal checkout
  let calls = 0;
  const w = createWorktreeWatcher({ worktreeDir: repo, onChange: () => { calls++; }, debounceMs: 50 });
  try {
    assert.equal(w.start(), false, 'no gitdir to watch -> start() declines');
    assert.equal(w.active, false);
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'x', 'utf8');
    await wait(150);
    assert.equal(calls, 0);
    assert.doesNotThrow(() => w.stop());
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
