// Integration-branch movement LISTENER - the event-driven replacement for the old 10s backstop poll's
// one unique job: noticing that a session's integration branch (e.g. develop) moved WITHOUT this
// session's own worktree changing. That happens when another session merges into develop, when the
// operator merges out-of-band (a CLI rebase-then-FF), or when this session itself merges - in every
// case a sibling worktree's merge gate (its ahead-count vs the integration branch) changes with no
// local gitdir/working-tree event, so neither the per-worktree gitdir watch nor the turn-end hook fires.
//
// WHY the reflog, not the ref: a branch tip lives EITHER in a loose ref file (refs/heads/<branch>) OR
// packed into packed-refs (after gc) OR, on newer git, a reftable - so watching the ref file misses a
// packed-refs rewrite. The REFLOG (logs/refs/heads/<branch>) is appended on EVERY update to the branch
// regardless of ref storage, so it is the single storage-agnostic "this branch moved" signal. We watch
// the reflog's PARENT directory non-recursively and filter on the branch leaf, so the watch survives
// the reflog file being created/rotated and ignores sibling branches' reflogs.
//
// commonGitDir is the SHARED gitdir all linked worktrees write refs into (`git rev-parse
// --git-common-dir`), so ONE watcher per (commonGitDir, branch) covers every session on that branch in
// that repo - the backend fans onChange out to the siblings.
//
// Like detection/worktree-watch.ts, fs.watch is fast but lossy (it can miss/duplicate events and throws
// if the path vanishes). That is fine: this is a best-effort accelerator. The session's other triggers
// (gitdir watch, turn-end hook) and the dashboard resync valves are the correctness floor. It self-stops
// on any error and never throws out of start()/stop().

import fs from 'node:fs';
import path from 'node:path';

import { createWatchDebounce } from './watch-debounce.ts';

// A one-directory, debounced fs.watch over an integration branch's reflog.
//   createIntegrationRefWatcher({ commonGitDir, branch, onChange, debounceMs? })
// start() is a no-op (returns false) when the reflog dir does not exist yet (the branch has never been
// updated, so there is nothing to merge into anyway); the caller can re-try on the next worktree-ready.
// onChange is called at most once per debounce window after a burst of ref writes; it receives no args.
function createIntegrationRefWatcher(
  { commonGitDir, branch, onChange, debounceMs = 400 }:
    {
      commonGitDir: string | null | undefined;
      branch: string | null | undefined;
      onChange: () => void;
      debounceMs?: number;
    },
) {
  const w = createWatchDebounce({ onChange, debounceMs });

  // logs/refs/heads/<branch>. The branch can be nested (e.g. release/x), so split the leaf from the dir
  // and watch the dir, filtering the leaf - a non-recursive watch on the exact parent.
  const reflogPath = commonGitDir && branch
    ? path.join(commonGitDir, 'logs', 'refs', 'heads', branch)
    : null;
  const watchDir = reflogPath ? path.dirname(reflogPath) : null;
  const leaf = reflogPath ? path.basename(reflogPath) : null;

  function start(): boolean {
    if (w.active || w.stopped || !watchDir) return w.active;
    let exists: boolean;
    try { exists = fs.existsSync(watchDir); } catch { exists = false; }
    if (!exists) return false; // no reflog dir yet; the floor (turn-end / gitdir watch) still covers it
    return w.watch(watchDir, (_evt, filename) => {
      // filename is the changed entry. Fire only for our branch's reflog; a null filename (some
      // platforms omit it) is treated as "maybe ours" and fires, since the watch is lossy anyway.
      if (!filename || filename === leaf) w.fire();
    });
  }

  return { start, stop: w.stop, get active() { return w.active; } };
}

export { createIntegrationRefWatcher };
