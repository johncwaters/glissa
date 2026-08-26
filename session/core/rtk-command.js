'use strict';

const path = require('node:path');

const { resolvePathCommandMatches } = require('./spawn-command');

function firstExistingFile(candidates, fsApi) {
  for (const candidate of candidates) {
    try {
      if (fsApi.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // existence probe: any stat failure just means try the next candidate
    }
  }
  return null;
}

function resolveRtkPath({
  homeDir,
  platform,
  exec,
  fsApi,
} = /** @type {{ homeDir?: string, platform?: NodeJS.Platform,
  exec?: (command: string, options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: number }) => string | Buffer,
  fsApi?: { statSync: (path: string) => { isFile: () => boolean } } }} */ ({})) {
  const bundledCandidates = [
    path.join(homeDir, '.glissa', 'bin', 'rtk.exe'),
    path.join(homeDir, '.glissa', 'bin', 'rtk'),
  ];
  const bundled = firstExistingFile(bundledCandidates, fsApi);
  if (bundled) return bundled;

  const matches = resolvePathCommandMatches('rtk', { platform, exec });
  if (matches.length === 0) return null;
  return path.resolve(matches[0]);
}

function quoteCommandPath(commandPath) {
  if (!/\s/.test(commandPath)) return commandPath;
  return `"${commandPath}"`;
}

function toForwardSlashes(commandPath) {
  return commandPath.replace(/\\/g, '/');
}

function buildRtkHookEntry(rtkPath) {
  // Forward slashes: Claude Code executes command hooks via git-bash, which eats backslashes.
  const command = `${quoteCommandPath(toForwardSlashes(rtkPath))} hook claude`;
  return {
    matcher: 'Bash',
    hooks: [{ type: 'command', command }],
  };
}

module.exports = {
  resolveRtkPath,
  buildRtkHookEntry,
};
