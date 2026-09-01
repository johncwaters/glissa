import path from 'node:path';

import { resolvePathCommandMatches } from './spawn-command.ts';
import type { PathLookupExec } from './spawn-command.ts';

interface StatApi {
  statSync: (path: string) => { isFile: () => boolean };
}

interface RtkPathInputs {
  homeDir: string;
  platform: NodeJS.Platform;
  exec: PathLookupExec;
  fsApi: StatApi;
}

interface RtkHookEntry {
  matcher: string;
  hooks: { type: string; command: string }[];
}

function firstExistingFile(candidates: readonly string[], fsApi: StatApi): string | null {
  for (const candidate of candidates) {
    try {
      if (fsApi.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
    }
  }
  return null;
}

function resolveRtkPath({ homeDir, platform, exec, fsApi }: RtkPathInputs): string | null {
  const bundledCandidates = [
    path.join(homeDir, '.glissa', 'bin', 'rtk.exe'),
    path.join(homeDir, '.glissa', 'bin', 'rtk'),
  ];
  const bundled = firstExistingFile(bundledCandidates, fsApi);
  if (bundled) return bundled;

  const matches = resolvePathCommandMatches('rtk', { platform, exec });
  if (matches.length === 0) return null;
  const firstMatch = matches[0];
  if (!firstMatch) return null;
  return path.resolve(firstMatch);
}

function quoteCommandPath(commandPath: string): string {
  if (!/\s/.test(commandPath)) return commandPath;
  return `"${commandPath}"`;
}

function toForwardSlashes(commandPath: string): string {
  return commandPath.replace(/\\/g, '/');
}

function buildRtkHookEntry(rtkPath: string): RtkHookEntry {
  const command = `${quoteCommandPath(toForwardSlashes(rtkPath))} hook claude`;
  return {
    matcher: 'Bash',
    hooks: [{ type: 'command', command }],
  };
}

export { resolveRtkPath, buildRtkHookEntry };
export type { RtkHookEntry, RtkPathInputs, StatApi };
