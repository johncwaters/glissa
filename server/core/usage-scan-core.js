'use strict';

const os = require('node:os');
const path = require('node:path');
const { stringOrNull } = require('./usage-number-core');

function decideFileRead(prior, stat) {
  if (!prior) return { action: 'restart', readFrom: 0 };
  if (!stat || typeof stat.size !== 'number') return { action: 'skip', readFrom: prior.offset || 0 };
  if (stat.size < (prior.size || 0)) return { action: 'restart', readFrom: 0 };
  if (stat.size < (prior.offset || 0)) return { action: 'restart', readFrom: 0 };
  if (stat.size === (prior.offset || 0) && stat.mtimeMs === prior.mtimeMs) return { action: 'skip', readFrom: prior.offset || 0 };
  return { action: 'append', readFrom: prior.offset || 0 };
}

function splitLines(carry, chunkText) {
  const text = `${carry || ''}${chunkText || ''}`;
  const lines = text.split(/\r?\n/);
  const nextCarry = text.endsWith('\n') || text.endsWith('\r\n') ? '' : lines.pop();
  return { lines: lines.filter((line) => line.length > 0), carry: nextCarry || '' };
}

function resolveProjectsDirs(env = process.env, extraDirs = [], isDirectory) {
  if (typeof isDirectory !== 'function') throw new TypeError('resolveProjectsDirs requires an isDirectory function');
  const surviving = projectDirCandidates(env, extraDirs).filter(isDirectory);
  if (!configDirOverride(env)) return surviving;
  const overrideSurvivors = projectDirCandidates(env, []).filter(isDirectory);
  if (overrideSurvivors.length === 0) throw new Error('CLAUDE_CONFIG_DIR is set but no projects directory exists');
  return surviving;
}

function projectDirCandidates(env = process.env, extraDirs = []) {
  const override = configDirOverride(env);
  const extraHomes = normalizeHomeCandidates(extraDirs, env);
  if (override) {
    const overrideHomes = normalizeHomeCandidates(override.split(','), env);
    return uniqueStrings([...projectsDirsFromHomes(overrideHomes), ...projectsDirsFromHomes(extraHomes)]);
  }

  const xdgConfigHome = stringOrNull(env.XDG_CONFIG_HOME) || path.join(homeDir(env), '.config');
  const defaultHomes = [path.join(xdgConfigHome, 'claude'), path.join(homeDir(env), '.claude')];
  return uniqueStrings([...projectsDirsFromHomes(defaultHomes), ...projectsDirsFromHomes(extraHomes)]);
}

function configDirOverride(env) {
  const override = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : '';
  return override.trim();
}

function projectsDirsFromHomes(homes) {
  const projectsDirs = [];
  for (const candidate of homes) {
    const home = path.basename(candidate) === 'projects' ? path.dirname(candidate) : candidate;
    const projectsDir = path.join(home, 'projects');
    projectsDirs.push(projectsDir);
  }
  return projectsDirs;
}

function normalizeHomeCandidates(candidates, env) {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((candidate) => expandTilde(String(candidate || '').trim(), env))
    .filter(Boolean);
}

function expandTilde(candidate, env) {
  if (candidate === '~') return homeDir(env);
  if (!candidate.startsWith(`~${path.sep}`) && !candidate.startsWith('~/')) return candidate;
  return path.join(homeDir(env), candidate.slice(2));
}

function homeDir(env) {
  return stringOrNull(env.HOME) || stringOrNull(env.USERPROFILE) || os.homedir();
}

function uniqueStrings(values) {
  return Array.from(new Set(values));
}

module.exports = {
  decideFileRead,
  projectDirCandidates,
  resolveProjectsDirs,
  splitLines,
};
