import fs from 'node:fs';
import os from 'node:os';

import { resolveRtkPath } from '../session/core/rtk-command.ts';
import { execSync } from './child-process-safe.ts';

function resolveRtkPathFromSystem(): string | null {
  return resolveRtkPath({
    homeDir: os.homedir(),
    platform: process.platform,
    exec: execSync,
    fsApi: fs,
  });
}

let cachedRtkPath: string | null = null;

function getRtkPath(resolve: () => string | null = resolveRtkPathFromSystem): string | null {
  if (!cachedRtkPath) cachedRtkPath = resolve();
  return cachedRtkPath;
}

function resetRtkPathCache(): void {
  cachedRtkPath = null;
}

export { getRtkPath, resetRtkPathCache };
