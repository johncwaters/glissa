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
  const override = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : '';
  const extraHomes = normalizeHomeCandidates(extraDirs, env);
  if (override.trim()) {
    const overrideHomes = normalizeHomeCandidates(override.split(','), env);
    const overrideProjects = projectsDirsForHomes(overrideHomes, isDirectory);
    if (overrideProjects.length === 0) throw new Error('CLAUDE_CONFIG_DIR is set but no projects directory exists');
    return uniqueStrings([...overrideProjects, ...projectsDirsForHomes(extraHomes, isDirectory)]);
  }

  const xdgConfigHome = stringOrNull(env.XDG_CONFIG_HOME) || path.join(homeDir(env), '.config');
  const defaultHomes = [path.join(xdgConfigHome, 'claude'), path.join(homeDir(env), '.claude')];
  return uniqueStrings([...projectsDirsForHomes(defaultHomes, isDirectory), ...projectsDirsForHomes(extraHomes, isDirectory)]);
}

function projectsDirsForHomes(homes, isDirectory) {
  const projectsDirs = [];
  for (const candidate of homes) {
    const home = path.basename(candidate) === 'projects' ? path.dirname(candidate) : candidate;
    const projectsDir = path.join(home, 'projects');
    if (!isDirectory(projectsDir)) continue;
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
  resolveProjectsDirs,
  splitLines,
};
