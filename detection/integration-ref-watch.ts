import fs from 'node:fs';
import path from 'node:path';

import { createWatchDebounce } from './watch-debounce.ts';

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

  const reflogPath = commonGitDir && branch
    ? path.join(commonGitDir, 'logs', 'refs', 'heads', branch)
    : null;
  const watchDir = reflogPath ? path.dirname(reflogPath) : null;
  const leaf = reflogPath ? path.basename(reflogPath) : null;

  function start(): boolean {
    if (w.active || w.stopped || !watchDir) return w.active;
    let exists: boolean;
    try { exists = fs.existsSync(watchDir); } catch { exists = false; }
    if (!exists) return false;
    return w.watch(watchDir, (_evt, filename) => {
      if (!filename || filename === leaf) w.fire();
    });
  }

  return { start, stop: w.stop, get active() { return w.active; } };
}

export { createIntegrationRefWatcher };
