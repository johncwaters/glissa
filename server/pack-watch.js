'use strict';

// A recursive, debounced fs.watch over one context-pack source root.
//
// The debounce, the coalescing of a write burst into one trailing call, and the stop lifecycle are
// detection/watch-debounce.js verbatim; only the fs.watch handle is ours. It has to be: that module
// watches ONE directory non-recursively (exactly right for the small gitdir it was written for),
// while a pack source glob like `sources/docs/**/*.md` spans nested directories that would otherwise
// never fire. Same lossy-watch posture as the detection watchers - the pack service's interval sweep
// is the correctness floor, so this is a latency optimization that self-stops on any error.

const fs = require('node:fs');

const { createWatchDebounce } = require('../detection/watch-debounce');
const { canonicalizePath } = require('../shared/paths');

function createPackWatcher({ onChange, debounceMs = 500 }) {
  const debounce = createWatchDebounce({ onChange, debounceMs });
  let watcher = null;

  function stop() {
    if (watcher) {
      try { watcher.close(); } catch { /* already closed */ }
      watcher = null;
    }
    debounce.stop();
  }

  // Recursive fs.watch is unsupported on Linux before Node 20, where this throws and the caller
  // silently falls back to the sweep. Canonical path required: fs.watch on an 8.3 short path aborts
  // the process from native code, past this catch (see canonicalizePath in shared/paths.js).
  function watch(dir) {
    if (watcher || debounce.stopped) return !!watcher;
    try {
      watcher = fs.watch(canonicalizePath(dir), { persistent: false, recursive: true }, () => debounce.fire());
      watcher.on('error', stop);
    } catch {
      watcher = null;
      return false;
    }
    return true;
  }

  return { watch, stop, get active() { return !!watcher; } };
}

module.exports = { createPackWatcher };
