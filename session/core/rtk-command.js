'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execSync } = require('../../server/child-process-safe');
const { dedupeClaudeMatches } = require('./spawn-command');

function firstExistingFile(candidates, fsApi = fs) {
  for (const candidate of candidates) {
    try {
      if (fsApi.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
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

  try {
    const command = platform === 'win32' ? 'where rtk' : 'which -a rtk';
    const out = exec(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const matches = dedupeClaudeMatches(out.split(/\r?\n/).filter((line) => line.trim()), platform);
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

function buildRtkHookEntry(rtkPath) {
  return {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: `${quoteCommandPath(rtkPath)} hook claude` }],
  };
}

const RTK_PATH = resolveRtkPath();

module.exports = {
  resolveRtkPath,
  buildRtkHookEntry,
  RTK_PATH,
};
