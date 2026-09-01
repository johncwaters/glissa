// Shared debounce-into-trailing-call + watch lifecycle for the single-directory fs.watch
// listeners in this folder (worktree-watch.ts, integration-ref-watch.ts). Both watch one
// directory and want at most one onChange() per write burst, plus a stop() that clears the
// timer and closes the watcher (idempotent, safe if the watcher was never started).
//
// The caller resolves its own target directory (the two watchers do that differently) and
// hands it to watch(); this module owns the fs.watch handle, its error handling, and the
// canonical-path requirement, so consumers never touch the raw watcher.

import fs from 'node:fs';
import type { FSWatcher, WatchListener } from 'node:fs';

import { canonicalizePath } from '../shared/paths.ts';

export interface WatchDebounce {
  fire: () => void;
  watch: (dir: string, listener?: WatchListener<string> | null) => boolean;
  stop: () => void;
  readonly active: boolean;
  readonly stopped: boolean;
}

function createWatchDebounce(
  { onChange, debounceMs }: { onChange: () => void; debounceMs: number },
): WatchDebounce {
  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  function fire(): void {
    if (timer) return; // coalesce a write burst into one trailing call
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      try { onChange(); } catch { /* a consumer error must not kill the watcher */ }
    }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // Attach a non-recursive fs.watch on dir; listener defaults to fire-on-any-event.
  // Returns whether a watcher is active. Any watcher error self-stops (the callers'
  // correctness floor covers missed events; see their headers).
  function watch(dir: string, listener?: WatchListener<string> | null): boolean {
    if (stopped || watcher) return !!watcher;
    try {
      // Canonical path required: fs.watch on an 8.3 short path aborts the process from
      // native code, past this catch (see canonicalizePath in shared/paths.ts).
      watcher = fs.watch(canonicalizePath(dir), { persistent: false }, listener || (() => fire()));
      watcher.on('error', stop);
    } catch {
      watcher = null;
      return false;
    }
    return true;
  }

  function stop(): void {
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

export { createWatchDebounce };
