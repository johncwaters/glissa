
import crypto from 'node:crypto';
import path from 'node:path';
import { SOURCE_DEFAULTS, scrubText } from './ingest-core.ts';

const SOURCE = 'fs';
const KIND = 'file-change';

const DEFAULT_BATCH_MS = SOURCE_DEFAULTS.fs.batchMs;

const MAX_FILES_PER_BATCH = SOURCE_DEFAULTS.fs.digestQuota;
const MAX_TRACKED_FILES = 2000;
const MAX_UNTRACKED_KEYS = 10000;
const UNTRACKED_KEY_CHARS = 16;
const MAX_ROOT_ENTRIES = 32;
const MAX_SAMPLE_FILES = 5;
const MAX_REL_PATH_CHARS = 200;
const TRUNCATED_SUFFIX = '...';

export type FsChangeKind = 'create' | 'update' | 'delete';

export interface FsBatch {
  files: Map<string, FsChangeKind>;
  untracked: Set<string>;
  floored: boolean;
}

export interface DaemonWriteRules {
  paths: string[];
  dir: string;
  prefix: string;
}

export type FsIngestEvent = {
  source: string;
  kind: string;
  ts: number;
  scope: { root: string | null; sessionId: string | null };
  summary: string;
  detail: Record<string, string | number | boolean>;
}

const IGNORED_DIR_NAMES: readonly string[] = Object.freeze([
  '.git',
  'node_modules',
  '.glissa',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.gradle',
  '.tox',
  '.venv',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.idea',
  '__pycache__',
  'dist',
  'build',
  'target',
  'coverage',
]);

const IGNORED_FILE_SUFFIXES: readonly string[] = Object.freeze(['~', '.swp', '.swx', '.swo', '.tmp', '.temp', '.lock']);
const IGNORED_FILE_NAMES: readonly string[] = Object.freeze(['.DS_Store', 'Thumbs.db', 'desktop.ini', '4913']);

const DAEMON_CONFIG_SIBLINGS: readonly string[] = Object.freeze([
  'usage-lanes.json',
  'usage-warehouse.json',
  'usage-budget-state.json',
  'pr-review-state.json',
  'pairings.json',
  'pairings-seen.json',
  'litellm-pricing.json',
  'update-check.json',
  'recordings',
  'uploads',
  'memory',
]);

const ACTIVE_SESSION_STATES: readonly string[] = Object.freeze(['INITIALIZING', 'STARTING', 'RUNNING', 'WAITING', 'IDLE', 'COMPLETE']);

const CHANGE_KINDS: readonly string[] = Object.freeze(['create', 'update', 'delete']);
const CHANGE_VERBS: Readonly<Record<FsChangeKind, string>> = Object.freeze({ create: 'created', update: 'updated', delete: 'deleted' });

function toPosix(value: unknown): string {
  return String(value == null ? '' : value).split('\\').join('/');
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}


function buildIgnorePatterns(extraDirNames: unknown[] = []): string[] {
  const names: string[] = [];
  for (const raw of [...IGNORED_DIR_NAMES, ...(Array.isArray(extraDirNames) ? extraDirNames : [])]) {
    const name = nonEmptyString(raw);
    if (!name || names.includes(name)) continue;
    names.push(name);
  }
  const patterns: string[] = [];
  for (const name of names) patterns.push(name, `**/${name}`, `**/${name}/**`);
  for (const suffix of IGNORED_FILE_SUFFIXES) patterns.push(`**/*${suffix}`);
  for (const name of IGNORED_FILE_NAMES) patterns.push(`**/${name}`);
  return patterns;
}

function hasIgnoredSegment(relPath: string): boolean {
  for (const segment of toPosix(relPath).split('/')) {
    if (!segment) continue;
    if (IGNORED_DIR_NAMES.includes(segment)) return true;
  }
  return false;
}

function isIgnoredFileName(base: string): boolean {
  if (IGNORED_FILE_NAMES.includes(base)) return true;
  return IGNORED_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

function daemonWriteRules(configPath: unknown): DaemonWriteRules | null {
  const resolvedPath = nonEmptyString(configPath);
  if (!resolvedPath) return null;
  const configFile = path.resolve(resolvedPath);
  const dir = path.dirname(configFile);
  return {
    paths: [configFile, ...DAEMON_CONFIG_SIBLINGS.map((name) => path.join(dir, name))],
    dir,
    prefix: `${path.basename(configFile)}.`,
  };
}

function isDaemonDerivedSibling(rules: DaemonWriteRules, absolutePath: string): boolean {
  const resolved = path.resolve(absolutePath);
  if (foldCase(path.dirname(resolved)) !== foldCase(rules.dir)) return false;
  return foldCase(path.basename(resolved)).startsWith(foldCase(rules.prefix));
}

function foldCase(value: unknown): string {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

function isPathInside(parent: unknown, child: unknown): boolean {
  const from = nonEmptyString(parent);
  const to = nonEmptyString(child);
  if (!from || !to) return false;
  const resolvedParent = path.resolve(from);
  const resolvedChild = path.resolve(to);
  if (foldCase(resolvedParent) === foldCase(resolvedChild)) return true;
  const relative = path.relative(resolvedParent, resolvedChild);
  if (!relative || path.isAbsolute(relative)) return false;
  return !toPosix(relative).startsWith('../');
}

function relativeWithin(root: unknown, absolutePath: unknown): string | null {
  const from = nonEmptyString(root);
  const to = nonEmptyString(absolutePath);
  if (!from || !to) return null;
  const relative = path.relative(path.resolve(from), path.resolve(to));
  if (!relative || path.isAbsolute(relative)) return null;
  const posix = toPosix(relative);
  if (posix.startsWith('../')) return null;
  return posix;
}

function isIgnoredChange({
  relPath,
  absolutePath = null,
  daemonRules = null,
}: { relPath?: unknown; absolutePath?: unknown; daemonRules?: DaemonWriteRules | null } = {}): boolean {
  const relative = nonEmptyString(relPath);
  if (!relative) return true;
  if (hasIgnoredSegment(relative)) return true;
  const base = toPosix(relative).split('/').pop();
  if (base && isIgnoredFileName(base)) return true;
  const absolute = nonEmptyString(absolutePath);
  if (!absolute || !daemonRules) return false;
  if (daemonRules.paths.some((daemonPath) => isPathInside(daemonPath, absolute))) return true;
  return isDaemonDerivedSibling(daemonRules, absolute);
}


function normalizeRoots(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const roots: string[] = [];
  for (const entry of raw) {
    const value = nonEmptyString(entry);
    if (!value || roots.includes(value)) continue;
    roots.push(value);
    if (roots.length >= MAX_ROOT_ENTRIES) break;
  }
  return roots;
}

function dedupeRoots(roots: unknown): string[] {
  const named: string[] = [];
  for (const entry of Array.isArray(roots) ? roots : []) {
    const value = nonEmptyString(entry);
    if (!value) continue;
    if (named.some((kept) => foldCase(path.resolve(kept)) === foldCase(path.resolve(value)))) continue;
    named.push(value);
  }
  named.sort((left, right) => left.length - right.length || left.localeCompare(right));
  const kept: string[] = [];
  for (const root of named) {
    if (kept.some((outer) => isPathInside(outer, root))) continue;
    kept.push(root);
  }
  return kept;
}

function deriveSessionRoots(session: { path?: unknown; worktreeDir?: unknown } | null | undefined): string[] {
  const dirs: string[] = [];
  for (const dir of [session?.path, session?.worktreeDir]) {
    const value = nonEmptyString(dir);
    if (!value || dirs.includes(value)) continue;
    dirs.push(value);
  }
  return dirs;
}

function isActiveSessionState(state: unknown): boolean {
  return ACTIVE_SESSION_STATES.includes(nonEmptyString(state) || '');
}


function createBatch(): FsBatch {
  return { files: new Map(), untracked: new Set(), floored: false };
}

function untrackedKey(relPath: string): string {
  return crypto.createHash('sha1').update(relPath, 'utf8').digest('hex').slice(0, UNTRACKED_KEY_CHARS);
}

function truncatePath(relPath: string): string {
  if (relPath.length <= MAX_REL_PATH_CHARS) return relPath;
  const scrubbed = scrubText(relPath);
  if (scrubbed.length <= MAX_REL_PATH_CHARS) return scrubbed;
  return `${scrubbed.slice(0, MAX_REL_PATH_CHARS)}${TRUNCATED_SUFFIX}`;
}

function normalizeChangeKind(type: unknown): FsChangeKind | null {
  const kind = nonEmptyString(type);
  if (!kind || !CHANGE_KINDS.includes(kind)) return null;
  return kind as FsChangeKind;
}

function mergeChange(previous: FsChangeKind | null | undefined, next: FsChangeKind): FsChangeKind | null {
  if (!previous) return next;
  if (previous === 'create' && next === 'delete') return null;
  if (next === 'delete') return 'delete';
  if (previous === 'create') return 'create';
  return 'update';
}

function recordChange(batch: FsBatch, relPath: unknown, type: unknown): boolean {
  const kind = normalizeChangeKind(type);
  const relative = nonEmptyString(relPath);
  if (!kind || !relative) return false;
  const key = truncatePath(relative);
  if (batch.files.has(key)) {
    const merged = mergeChange(batch.files.get(key), kind);
    if (merged === null) batch.files.delete(key);
    if (merged !== null) batch.files.set(key, merged);
    return true;
  }
  if (batch.files.size >= MAX_TRACKED_FILES) {
    const digest = untrackedKey(key);
    if (batch.untracked.has(digest)) return true;
    if (batch.untracked.size >= MAX_UNTRACKED_KEYS) {
      batch.floored = true;
      return true;
    }
    batch.untracked.add(digest);
    return true;
  }
  batch.files.set(key, kind);
  return true;
}

function batchSize(batch: FsBatch): number {
  return batch.files.size + batch.untracked.size;
}

function fileChangeEvent({
  root,
  relPath,
  change,
  now,
}: { root: string | null; relPath: string; change: FsChangeKind; now: number }): FsIngestEvent {
  return {
    source: SOURCE,
    kind: KIND,
    ts: now,
    scope: { root, sessionId: null },
    summary: `${CHANGE_VERBS[change]} ${relPath}`,
    detail: { path: relPath, change },
  };
}

function countByKind(batch: FsBatch): Record<FsChangeKind, number> {
  const counts: Record<FsChangeKind, number> = { create: 0, update: 0, delete: 0 };
  for (const change of batch.files.values()) counts[change] += 1;
  return counts;
}

function burstSummary(batch: FsBatch): { summary: string; counts: Record<FsChangeKind, number>; total: number } {
  const counts = countByKind(batch);
  const parts: string[] = [];
  if (counts.create) parts.push(`${counts.create} created`);
  if (counts.update) parts.push(`${counts.update} updated`);
  if (counts.delete) parts.push(`${counts.delete} deleted`);
  const total = batchSize(batch);
  const tail = parts.length > 0 ? `: ${parts.join(', ')}` : '';
  const lead = batch.floored ? `at least ${total}` : `${total}`;
  return { summary: `${lead} files changed${tail}`, counts, total };
}

function sampleOf(batch: FsBatch): string {
  return [...batch.files.keys()].slice(0, MAX_SAMPLE_FILES).join(', ');
}

function decideFsEvents(batch: FsBatch, { root = null, now = 0 }: { root?: string | null; now?: number } = {}): FsIngestEvent[] {
  const total = batchSize(batch);
  if (total === 0) return [];
  if (total <= MAX_FILES_PER_BATCH && batch.untracked.size === 0) {
    const events: FsIngestEvent[] = [];
    for (const [relPath, change] of batch.files) events.push(fileChangeEvent({ root, relPath, change, now }));
    return events;
  }
  const { summary, counts } = burstSummary(batch);
  return [{
    source: SOURCE,
    kind: KIND,
    ts: now,
    scope: { root, sessionId: null },
    summary,
    detail: {
      files: total,
      atLeast: batch.floored,
      created: counts.create,
      updated: counts.update,
      deleted: counts.delete,
      sample: sampleOf(batch),
    },
  }];
}

export {
  DEFAULT_BATCH_MS,
  IGNORED_DIR_NAMES,
  MAX_FILES_PER_BATCH,
  MAX_TRACKED_FILES,
  MAX_UNTRACKED_KEYS,
  SOURCE,
  TRUNCATED_SUFFIX,
  batchSize,
  buildIgnorePatterns,
  createBatch,
  daemonWriteRules,
  decideFsEvents,
  dedupeRoots,
  deriveSessionRoots,
  isActiveSessionState,
  isIgnoredChange,
  isPathInside,
  mergeChange,
  normalizeRoots,
  recordChange,
  relativeWithin,
};
