'use strict';

// Shared debounce-into-trailing-call + watch lifecycle for the single-directory fs.watch
// listeners in this folder (worktree-watch.js, integration-ref-watch.js). Both watch one
// directory and want at most one onChange() per write burst, plus a stop() that clears the
// timer and closes the watcher (idempotent, safe if the watcher was never started).
//
// The caller resolves its own target directory (the two watchers do that differently) and
// hands it to watch(); this module owns the fs.watch handle, its error handling, and the
// canonical-path requirement, so consumers never touch the raw watcher.

const fs = require('node:fs');

const { canonicalizePath } = require('../shared/paths');

function createWatchDebounce({ onChange, debounceMs }) {
  /** @type {fs.FSWatcher|null} */
  let watcher = null;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  let stopped = false;

  function fire() {
    if (timer) return; // coalesce a write burst into one trailing call
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      try { onChange(); } catch { /* a consumer error must not kill the watcher */ }
    }, debounceMs);
    if (timer.unref) timer.unref();
  }

  // Attach a non-recursive fs.watch on dir; listener defaults to fire-on-any-event.
  // Returns whether a watcher is active. Any watcher error self-stops (the callers'
  // correctness floor covers missed events; see their headers).
  function watch(dir, listener) {
    if (stopped || watcher) return !!watcher;
    try {
      // Canonical path required: fs.watch on an 8.3 short path aborts the process from
      // native code, past this catch (see canonicalizePath in shared/paths.js).
      watcher = fs.watch(canonicalizePath(dir), { persistent: false }, listener || (() => fire()));
      watcher.on('error', stop);
    } catch {
      watcher = null;
      return false;
    }
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (watcher) {
      try { watcher.close(); } catch { /* already closed */ }
      watcher = null;
    }
  }

  return {
    fire,
    watch,
    stop,
    get active() { return !!watcher; },
    get stopped() { return stopped; },
  };
}

module.exports = { createWatchDebounce };
