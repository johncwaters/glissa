import fs from 'node:fs';
import path from 'node:path';

import { createWatchDebounce } from './watch-debounce.ts';
import type { WatchDebounce } from './watch-debounce.ts';

const RR_CACHE_DIR = 'rr-cache';

function createRerereWatcher(
  { commonGitDir, onChange, debounceMs = 400 }:
    { commonGitDir: string | null | undefined; onChange: () => void; debounceMs?: number },
) {
  const cacheDir = commonGitDir ? path.join(commonGitDir, RR_CACHE_DIR) : null;
  const inner = createWatchDebounce({ onChange, debounceMs });

  let outer: WatchDebounce | null = null;

  function watchCache(): boolean {
    if (!cacheDir) return false;
    return inner.watch(cacheDir);
  }

  function startOuter(): boolean {
    outer = createWatchDebounce({
      onChange: () => {
        if (!watchCache()) return;
        onChange();
        if (outer) outer.stop();
      },
      debounceMs,
    });
    const outerWatch = outer;
    if (!outerWatch || !commonGitDir) return false;
    return outerWatch.watch(commonGitDir, (_evt, filename) => {
      if (!filename || filename === RR_CACHE_DIR) outerWatch.fire();
    });
  }

  function start(): boolean {
    if (inner.active || inner.stopped || !cacheDir) return inner.active;
    let exists: boolean;
    try { exists = fs.existsSync(cacheDir); } catch { exists = false; }
    if (exists) return watchCache();
    return startOuter();
  }

  function stop(): void {
    if (outer) outer.stop();
    inner.stop();
  }

  return { start, stop, get active() { return inner.active || Boolean(outer?.active); } };
}

export { createRerereWatcher, RR_CACHE_DIR };
