'use strict';

// Ref-counted pool of integration-ref watchers: at most ONE fs.watch per (commonGitDir, branch), shared
// by every session on that repo+branch. When a watched branch moves, re-check every live-worktree
// session sharing that commonGitDir - the cross-session / out-of-band merge case the old 10s poll used
// to cover. This is pure lifecycle + fan-out logic; the watcher factory, the session registry, and the
// per-session re-check are injected so it is unit-testable without a real backend or a real fs.watch.
//
//   createIntegrationWatcherPool({ sessions, createWatcher, recheck, isEnabled? })
//     sessions    - the live Map<id, session> (iterated on a branch move to find siblings)
//     createWatcher({ commonGitDir, branch, onChange }) -> { start(), stop() }
//     recheck(session) - re-evaluate one session's worktree gate (backend: checkWorktreeChange)
//     isEnabled() - master kill-switch hook (backend: config.liveWorktreeReview !== false)
function createIntegrationWatcherPool({ sessions, createWatcher, recheck, isEnabled = () => true }) {
  const watchers = new Map(); // `${commonGitDir}::${branch}` -> { watcher, refs: Set<sessionId> }

  // Start (or join) the watcher for this session's integration branch. Idempotent per session id.
  function ensure(sess) {
    if (!isEnabled()) return;
    const commonGitDir = sess.commonGitDir;
    const branch = sess.integrationBranch;
    if (!commonGitDir || !branch) return;
    const key = `${commonGitDir}::${branch}`;
    let entry = watchers.get(key);
    if (!entry) {
      const watcher = createWatcher({
        commonGitDir,
        branch,
        onChange: () => {
          // The branch moved: re-check every live-worktree session sharing this gitdir, so a sibling
          // whose gate changed without its own worktree moving updates. recheck (checkWorktreeChange)
          // dedups, so a no-op sibling costs one cheap signature and nothing more.
          for (const [, s] of sessions) {
            if (s.commonGitDir === commonGitDir && s.worktreeDir) recheck(s);
          }
        },
      });
      entry = { watcher, refs: new Set() };
      watchers.set(key, entry);
      watcher.start();
    }
    entry.refs.add(sess.id);
  }

  // Drop a session's hold; stop the watcher when the last holder goes away. Iterates by session id (not a
  // recomputed key) so it works even after a teardown already cleared the session's commonGitDir.
  function release(sess) {
    for (const [key, entry] of watchers) {
      if (!entry.refs.delete(sess.id)) continue;
      if (entry.refs.size === 0) {
        try { entry.watcher.stop(); } catch { /* already stopped */ }
        watchers.delete(key);
      }
    }
  }

  // Stop and forget every watcher (server shutdown).
  function stopAll() {
    for (const [, entry] of watchers) {
      try { entry.watcher.stop(); } catch { /* already stopped */ }
    }
    watchers.clear();
  }

  return { ensure, release, stopAll, get size() { return watchers.size; } };
}

module.exports = { createIntegrationWatcherPool };
