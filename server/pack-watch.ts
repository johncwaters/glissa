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
      try { watcher.close(); } catch {  }
      watcher = null;
    }
    debounce.stop();
  }

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
