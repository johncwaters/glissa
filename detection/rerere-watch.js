'use strict';

// rerere-cache LISTENER: the "new information" event for the auto-rebase conflict cooldown.
//
// The cooldown is keyed on `${headSha}::${targetSha}` so a doomed rebase is not retried on every
// watcher nudge, and it expires when either sha moves. The documented limitation that leaves is
// information-shaped, not time-shaped: a SIBLING session resolving the same conflict records it in the
// shared rr-cache, and this worktree could then replay that resolution and finish - but nothing about
// this worktree changed, so the cooldown holds until a sha happens to move. The merge-queue answer is
// to treat the recorded resolution itself as the retry trigger, and that is one directory.
//
// WHERE: rerere's cache lives in the COMMON gitdir (`<commonGitDir>/rr-cache`), shared by every linked
// worktree of the repo, which is what makes one resolution reach every session for free. Each recorded
// resolution is a new `rr-cache/<hash>/` entry, so a NON-recursive watch on that directory sees exactly
// the event worth reacting to. git creates rr-cache lazily on the first recorded resolution, so a
// repo that has never recorded one has nothing to watch yet: the watcher then watches the common
// gitdir for that directory appearing and upgrades itself.
//
// Like the other watchers here, fs.watch is fast but lossy, and that is fine: the cooldown's own
// sha-move expiry and the eventual Merge click remain the correctness floor. Self-stops on any error,
// never throws out of start()/stop().

const fs = require('node:fs');
const path = require('node:path');

const { createWatchDebounce } = require('./watch-debounce');

const RR_CACHE_DIR = 'rr-cache';

function createRerereWatcher({ commonGitDir, onChange, debounceMs = 400 }) {
  const cacheDir = commonGitDir ? path.join(commonGitDir, RR_CACHE_DIR) : null;
  const inner = createWatchDebounce({ onChange, debounceMs });
  // The outer watch exists only to notice rr-cache being CREATED; it hands over and stops itself.
  let outer = null;

  function watchCache() {
    return inner.watch(cacheDir);
  }

  function startOuter() {
    outer = createWatchDebounce({
      onChange: () => {
        // rr-cache just appeared: take over the real watch, and treat its creation as the first
        // recorded resolution, which is exactly the event this exists for.
        if (watchCache()) onChange();
        outer.stop();
      },
      debounceMs,
    });
    return outer.watch(commonGitDir, (_evt, filename) => {
      if (!filename || filename === RR_CACHE_DIR) outer.fire();
    });
  }

  function start() {
    if (inner.active || inner.stopped || !cacheDir) return inner.active;
    let exists;
    try { exists = fs.existsSync(cacheDir); } catch { exists = false; }
    if (exists) return watchCache();
    return startOuter();
  }

  function stop() {
    if (outer) outer.stop();
    inner.stop();
  }

  return { start, stop, get active() { return inner.active || Boolean(outer?.active); } };
}

module.exports = { createRerereWatcher, RR_CACHE_DIR };
