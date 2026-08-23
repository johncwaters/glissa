'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execSync } = require('../../server/child-process-safe');
const { dedupePathMatches } = require('./spawn-command');

function firstExistingFile(candidates, fsApi = fs) {
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
  homeDir = os.homedir(),
  platform = process.platform,
  exec = execSync,
  fsApi = fs,
} = {}) {
  const bundledCandidates = [
    path.join(homeDir, '.glissa', 'bin', 'rtk.exe'),
    path.join(homeDir, '.glissa', 'bin', 'rtk'),
  ];
  const bundled = firstExistingFile(bundledCandidates, fsApi);
  if (bundled) return bundled;

  const resolvePathMatches = (command) => {
    const out = exec(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return dedupePathMatches(out.split(/\r?\n/).filter((line) => line.trim()), platform);
  };

  try {
    const command = platform === 'win32' ? 'where rtk' : 'which -a rtk';
    const matches = resolvePathMatches(command);
    if (matches.length === 0 && platform === 'win32') return null;
    if (matches.length === 0) throw new Error('no PATH matches');
    return path.resolve(matches[0]);
  } catch {
    if (platform === 'win32') return null;
  }

  try {
    const matches = resolvePathMatches('sh -c "command -v rtk"');
    if (matches.length === 0) return null;
    return path.resolve(matches[0]);
  } catch {
    return null;
  }
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

// Lazy, success-only memo: nothing is probed until rtk is actually consulted (settings dialog or an
// rtk-enabled spawn), and a miss is re-probed so installing rtk later needs no server restart.
let cachedRtkPath = null;
function getRtkPath() {
  if (!cachedRtkPath) cachedRtkPath = resolveRtkPath();
  return cachedRtkPath;
}

module.exports = {
  resolveRtkPath,
  buildRtkHookEntry,
  getRtkPath,
};
