import fs from 'node:fs';

import { configSiblingPath } from './pairings-store.ts';
import { pruneAgedFiles } from './prune-files.ts';

const UPLOAD_RETAIN_DAYS = 7;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function createUploadsWiring({
  configPath,
  liveSessionIds,
  setIntervalFn = (fn: () => void, ms: number) => setInterval(fn, ms),
  clearIntervalFn = clearInterval,
}: {
  configPath: string | null;
  liveSessionIds: () => Set<string>;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
}) {
  const uploadsRoot = configSiblingPath(configPath, 'uploads');
  let timer: NodeJS.Timeout | null = null;
  async function prune(): Promise<void> {
    const retainedSessionIds = liveSessionIds();
    await pruneAgedFiles({
      directory: uploadsRoot,
      suffixes: [''],
      retainDays: UPLOAD_RETAIN_DAYS,
      entryMode: 'directory',
      isRetainedId: (id) => retainedSessionIds.has(id),
      fsPromises: fs.promises,
    });
  }
  async function start(): Promise<void> {
    if (timer) return;
    await prune();
    timer = setIntervalFn(() => { void prune(); }, PRUNE_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
  function stop(): void {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }
  return { start, stop, prune };
}

export { createUploadsWiring };
