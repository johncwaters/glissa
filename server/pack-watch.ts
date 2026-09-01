// A recursive, debounced fs.watch over one context-pack source root.
//
// The debounce, the coalescing of a write burst into one trailing call, and the stop lifecycle are
// detection/watch-debounce.ts verbatim; only the fs.watch handle is ours. It has to be: that module
// watches ONE directory non-recursively (exactly right for the small gitdir it was written for),
// while a pack source glob like `sources/docs/**/*.md` spans nested directories that would otherwise
// never fire. Same lossy-watch posture as the detection watchers - the pack service's interval sweep
// is the correctness floor, so this is a latency optimization that self-stops on any error.

import fs from 'node:fs';

import { createWatchDebounce } from '../detection/watch-debounce.ts';
import { canonicalizePath } from '../shared/paths.ts';

interface PackWatcher {
  watch(dir: string): boolean;
  stop(): void;
  readonly active: boolean;
}

function createPackWatcher(
  { onChange, debounceMs = 500 }: { onChange: () => void; debounceMs?: number },
): PackWatcher {
  const debounce = createWatchDebounce({ onChange, debounceMs });
  let watcher: fs.FSWatcher | null = null;

  function stop(): void {
    if (watcher) {
      try { watcher.close(); } catch { /* already closed */ }
      watcher = null;
    }
    debounce.stop();
  }

  // Recursive fs.watch is unsupported on Linux before Node 20, where this throws and the caller
  // silently falls back to the sweep. Canonical path required: fs.watch on an 8.3 short path aborts
  // the process from native code, past this catch (see canonicalizePath in shared/paths.ts).
  function watch(dir: string): boolean {
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

export { createPackWatcher };
export type { PackWatcher };
