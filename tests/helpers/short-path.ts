import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';

function shortPathOf(target: string): string | null {
  if (!WIN) return null;
  const probe = spawnSync('cmd', [`/d /c for %I in ("${target}") do @echo %~sI`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  });
  if (probe.error || probe.status !== 0) return null;
  const out = probe.stdout.trim();
  if (!out || out.toLowerCase() === target.toLowerCase()) return null;
  return out;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-shortpath-longname-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SHORT_NAMES_AVAILABLE = withTempDir((dir) => shortPathOf(dir) !== null);

export { SHORT_NAMES_AVAILABLE, shortPathOf, withTempDir };
