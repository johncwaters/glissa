'use strict';

// Worktree change LISTENER - the fast, event-driven half of the review-gate's
// "did this session's worktree change?" detector. It does NOT scrape, parse, or
// poll: it fs.watches the small per-worktree git metadata directory and fires
// onChange when git state moves (a commit / stage / checkout / reset inside the
// worktree). The expensive truth (the actual diff + the cheap signature) is
// recomputed by sessions.js on that nudge; this module only says "look again".
//
// WHY the gitdir, not the working tree: a linked worktree marks its root with a
// `.git` FILE that points at `<repo>/.git/worktrees/<name>`. A commit changes no
// working-tree file (the file was already saved), so a working-tree watch would
// miss it and the committed-vs-uncommitted split would go stale. The per-worktree
// gitdir, by contrast, holds `index` / `COMMIT_EDITMSG` / `HEAD` / `ORIG_HEAD`,
// which DO change on stage/commit/reset - and it contains none of the working
// tree's noise (no node_modules, no editor temp files), so a non-recursive watch
// over it is both precise and cheap on Windows (ReadDirectoryChangesW).
//
// Uncommitted working-tree edits are NOT this module's job: those are picked up by
// the session's turn-end (Stop) hook. This watcher exists to make the COMMIT boundary
// land in the UI in well under a second.
//
// fs.watch is fast but lossy (it can miss or duplicate events, and throws if the
// watched path vanishes). That is fine here: the turn-end hook, the integration-ref
// watcher (cross-session / out-of-band merges), and the selected session's diff re-fetch
// on selection are the correctness floor, so this watcher is a best-effort accelerator
// that self-stops on any error and never throws out of start()/stop().

const fs = require('node:fs');
const path = require('node:path');

const { createWatchDebounce } = require('./watch-debounce');

// Resolve a linked worktree's per-worktree git metadata dir from its `.git`
// pointer file (`gitdir: <path>`), or null when `dir` is not a linked worktree
// (a normal checkout has a `.git` DIRECTORY; a submodule points at `modules/`).
// The pointer may be absolute or, on Git 2.48+ `--relative-paths`, relative to
// the worktree dir - both are resolved to an absolute path. fs-only, never throws.
function resolveWorktreeGitDir(dir) {
  if (!dir) return null;
  try {
    const dotGit = path.join(dir, '.git');
    if (!fs.statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    // .trim() drops a CRLF tail; require a `worktrees/` segment (separator-agnostic)
    // so a submodule's `modules/` pointer is rejected, mirroring detectLinkedWorktree.
    const raw = m[1].trim();
    if (!/(^|[/\\])worktrees[/\\]/.test(raw)) return null;
    const resolved = path.resolve(dir, raw);
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

// A one-directory, debounced fs.watch over a worktree's gitdir.
//   createWorktreeWatcher({ worktreeDir, onChange, debounceMs? })
// start() is a no-op (returns false) when worktreeDir is not a linked worktree, so
// in-place / non-git sessions silently skip watching (they have no review worktree to track).
// onChange is called at most once per debounce window after a burst of git writes
// (a single `git commit` touches several files); it receives no arguments.
function createWorktreeWatcher({ worktreeDir, onChange, debounceMs = 400 }) {
  const w = createWatchDebounce({ onChange, debounceMs });

  function start() {
    if (w.active || w.stopped) return w.active;
    const gitDir = resolveWorktreeGitDir(worktreeDir);
    if (!gitDir) return false;
    // Non-recursive: only the gitdir's direct children (index, HEAD, COMMIT_EDITMSG,
    // ORIG_HEAD, MERGE_HEAD) carry the stage/commit/reset signal we want. The gitdir can be
    // removed out from under us (worktree pruned); watch() self-stops on watcher error and
    // the turn-end hook + a later re-check still cover the session.
    return w.watch(gitDir);
  }

  return { start, stop: w.stop, get active() { return w.active; } };
}

module.exports = { createWorktreeWatcher, resolveWorktreeGitDir };
