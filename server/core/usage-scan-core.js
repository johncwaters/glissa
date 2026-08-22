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

// ── Other agent CLIs ──
// Codex and Grok keep their transcripts in their own homes, in their own layouts. The usage lane reads
// Claude only; these are here for the INGEST lane (server/ingest-agent-logs.js), which tails all three.

// The env override is comma-split like CLAUDE_CONFIG_DIR, so several homes can be scanned.
function vendorHomes(env, varName, defaultDirName) {
  const override = typeof env?.[varName] === 'string' ? env[varName].trim() : '';
  if (override) return normalizeHomeCandidates(override.split(','), env);
  return [path.join(homeDir(env), defaultDirName)];
}

function codexHomes(env = process.env) {
  return vendorHomes(env, 'CODEX_HOME', '.codex');
}

function grokHomes(env = process.env) {
  return vendorHomes(env, 'GROK_HOME', '.grok');
}

function codexRootCandidates(homes) {
  const candidates = [];
  for (const home of homes) {
    candidates.push({ dir: path.join(home, 'sessions'), kind: 'active', home });
    candidates.push({ dir: path.join(home, 'archived_sessions'), kind: 'archived', home });
  }
  return candidates;
}

// Grok stores one updates.jsonl per session under sessions/<encoded-cwd>/<session-id>/.
function grokRootCandidates(homes) {
  return homes.map((home) => ({ dir: path.join(home, 'sessions'), kind: 'active', home }));
}

const GROK_USAGE_FILENAME = 'updates.jsonl';

// Which files in a vendor's tree carry turns at all. Grok is the narrow one: everything else in its
// session dir is transcript detail nothing reads.
function isUsageFile(vendor, fileName) {
  if (typeof fileName !== 'string') return false;
  if (vendor === 'grok') return fileName === GROK_USAGE_FILENAME;
  return fileName.endsWith('.jsonl');
}

// The Codex session id is the trailing uuid of a rollout file name; the basename is the fallback for
// any other layout.
function codexSessionIdFromPath(filePath) {
  const base = path.basename(String(filePath || ''), '.jsonl');
  const match = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(base);
  if (match) return match[1];
  return base || null;
}

module.exports = {
  decideFileRead,
  projectDirCandidates,
  resolveProjectsDirs,
  splitLines,
  codexHomes,
  grokHomes,
  codexRootCandidates,
  grokRootCandidates,
  codexSessionIdFromPath,
  isUsageFile,
  GROK_USAGE_FILENAME,
};
