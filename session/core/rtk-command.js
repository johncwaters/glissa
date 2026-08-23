'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execSync } = require('../../server/child-process-safe');
const { resolvePathCommandMatches } = require('./spawn-command');

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
