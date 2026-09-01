import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session/sessions.ts';
// Build a throwaway working dir and return its path plus a cleanup fn. The caller
// seeds it with a `.git` entry to exercise each detection branch.
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-wt-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Construct a Session for `dir` without spawning (no start()), so only the
// constructor-time worktree detection runs.
function sessionFor(dir: string) {
  return new Session({ id: 'wt', name: 'wt', path: dir });
}

test('a normal checkout (.git directory) is not a worktree', () => {
  const { dir, cleanup } = tmpDir();
  fs.mkdirSync(path.join(dir, '.git'));
  const s = sessionFor(dir);
  try {
    assert.equal(s.isWorktree, false);
    assert.equal(s.toSnapshot().isWorktree, false);
  } finally {
    s.destroy();
    cleanup();
  }
});

test('a linked worktree (.git file pointing at /worktrees/) is a worktree', () => {
  const { dir, cleanup } = tmpDir();
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /repo/.git/worktrees/feature\n');
  const s = sessionFor(dir);
  try {
    assert.equal(s.isWorktree, true);
    assert.equal(s.toSnapshot().isWorktree, true);
  } finally {
    s.destroy();
    cleanup();
  }
});

test('a relative worktree pointer (Git 2.48+ --relative-paths) is a worktree', () => {
  const { dir, cleanup } = tmpDir();
  // No leading slash: the `(^|/)worktrees/` anchor must still match.
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ../.git/worktrees/feature\n');
  const s = sessionFor(dir);
  try {
    assert.equal(s.isWorktree, true);
  } finally {
    s.destroy();
    cleanup();
  }
});

test('a Windows backslash + CRLF gitdir is a worktree (path normalization)', () => {
  const { dir, cleanup } = tmpDir();
  // The form git actually writes on Windows: backslash separators, CRLF line end.
  // Locks both the .replace(/\\/g,'/') and the .trim() in detectLinkedWorktree.
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: C:\\repo\\.git\\worktrees\\feature\r\n');
  const s = sessionFor(dir);
  try {
    assert.equal(s.isWorktree, true);
  } finally {
    s.destroy();
    cleanup();
  }
});

test('a submodule (.git file pointing at /modules/) is not flagged as a worktree', () => {
  const { dir, cleanup } = tmpDir();
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /repo/.git/modules/sub\n');
  const s = sessionFor(dir);
  try {
    assert.equal(s.isWorktree, false);
  } finally {
    s.destroy();
    cleanup();
  }
});

test('a non-git directory is not a worktree', () => {
  const { dir, cleanup } = tmpDir();
  const s = sessionFor(dir);
  try {
    assert.equal(s.isWorktree, false);
  } finally {
    s.destroy();
    cleanup();
  }
});

test('refreshGitContext reports the change only on the transition', () => {
  const { dir, cleanup } = tmpDir();
  fs.mkdirSync(path.join(dir, '.git'));
  const s = sessionFor(dir);
  try {
    assert.equal(s.isWorktree, false);
    // Turn the dir into a linked worktree mid-session.
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /repo/.git/worktrees/feature\n');
    assert.equal(s.refreshGitContext(), true);
    assert.equal(s.isWorktree, true);
    // A second poll with no change is a no-op (no spurious rebroadcast).
    assert.equal(s.refreshGitContext(), false);
    assert.equal(s.isWorktree, true);
  } finally {
    s.destroy();
    cleanup();
  }
});
