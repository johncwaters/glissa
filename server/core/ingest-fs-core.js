/*
 * Pure core of the fs ingest source (docs/plan-ingestion.md, M9): the ignore set, the root set (config
 * normalization, canonical dedupe, the nesting collapse), the session-to-root derivation, the per-file
 * coalescing state machine, and the decision of which events a settled batch owes. No IO, no timers, no
 * clock: the shell hands in watcher events and a `now` and gets a verdict back.
 *
 * COALESCING is the load-bearing piece. @parcel/watcher already coalesces in C++, but one `npm install`
 * still touches thousands of paths and one `git checkout` rewrites a working tree, and since M7.5 every
 * published event advances the navigator's movement signal, so a per-event publish would spend real
 * dispatch budget on churn nobody typed. Two bounds therefore sit here: one event per FILE per window,
 * and one event for the whole WINDOW once its file count says a burst happened rather than an edit.
 *
 * The ignore set is the other half, and it runs TWICE by design. The glob forms go to the watcher, which
 * applies them before registration, so a storm inside an ignored tree never reaches this process at all
 * (and on Linux never costs an inotify watch). The predicate here re-checks what did arrive, which is
 * what covers the daemon's own state files: they sit beside the resolved config file, which in a dev
 * checkout is inside the very repo a session is working in.
 */

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { SOURCE_DEFAULTS } = require('./ingest-core');

const SOURCE = 'fs';
const KIND = 'file-change';

// The config resolver owns this number; re-exporting it keeps the shell's fallback from drifting.
const DEFAULT_BATCH_MS = SOURCE_DEFAULTS.fs.batchMs;

/*
 * Above this many distinct files in one window the batch publishes ONE burst event instead of a line per
 * file. The number is the fs digest quota (docs/plan-ingestion.md Sources table): a window that produced
 * more per-file events than the digest could ever render is pure ring churn and dispatch budget, and a
 * carbon unit saving a file does not touch nine of them at once.
 */
const MAX_FILES_PER_BATCH = SOURCE_DEFAULTS.fs.digestQuota;
/*
 * The per-window bound on DISTINCT tracked files. Past it the batch keeps counting but stops remembering
 * names, so a checkout of a 50000-file tree costs one number rather than a map of every path in it.
 */
const MAX_TRACKED_FILES = 2000;
/*
 * Past MAX_TRACKED_FILES the count still has to be of DISTINCT FILES, not of events: @parcel/watcher
 * reports a create and an update for one written file, so counting events would report a 3000-file
 * checkout as 6000. Names are no longer worth holding at that scale, so what is held is a short hash per
 * path, itself capped: past this many the batch can no longer tell a new file from a repeat, and says so
 * by reporting its total as a floor rather than a count.
 */
const MAX_UNTRACKED_KEYS = 10000;
const UNTRACKED_KEY_CHARS = 16;
const MAX_ROOT_ENTRIES = 32;
const MAX_SAMPLE_FILES = 5;
const MAX_REL_PATH_CHARS = 200;
/*
 * Appended to a path this batch had to truncate. Two files sharing a 200-char prefix still merge, which
 * truncation cannot avoid, but the published path now says it names no exact file instead of reading as a
 * real one. Three ASCII periods, never the ellipsis character (house rule).
 */
const TRUNCATED_SUFFIX = '...';

/*
 * Directories a watcher must never descend into. Two costs, not one: a dependency tree or a build output
 * floods the ring and spends dispatch budget on churn, and on Linux every subdirectory of a recursive
 * watch costs an inotify watch, which is what exhausts fs.inotify.max_user_watches. `.glissa` is in the
 * list because the daemon's own home (recordings, uploads, built packs, every state file) lives there,
 * and an operator who names a wide explicit root would otherwise watch glissa watching itself.
 */
const IGNORED_DIR_NAMES = Object.freeze([
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

// Editor scratch and OS droppings: a write here is a side effect of a save, never the save itself.
const IGNORED_FILE_SUFFIXES = Object.freeze(['~', '.swp', '.swx', '.swo', '.tmp', '.temp', '.lock']);
const IGNORED_FILE_NAMES = Object.freeze(['.DS_Store', 'Thumbs.db', 'desktop.ini', '4913']);

/*
 * What the daemon itself writes beside its resolved config file. In a dev checkout that file IS the
 * in-repo config.json, so these sit inside a root a glissa session is working in, and the config save
 * that persists `resumeSessionId` fires on every hook of every turn. Without this the daemon's own
 * bookkeeping would publish an event that pokes the next navigator dispatch, which is the feedback loop
 * M7.5 made expensive rather than merely noisy.
 */
const DAEMON_CONFIG_SIBLINGS = Object.freeze([
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
]);

// The states in which a session is a live checkout worth following. DORMANT has never started and
// DONE/FAILED have exited, which is exactly the "first session in a root starts / last one exits" edge
// the plan's ref-counting rule is written against.
const ACTIVE_SESSION_STATES = Object.freeze(['INITIALIZING', 'STARTING', 'RUNNING', 'WAITING', 'IDLE', 'COMPLETE']);

const CHANGE_KINDS = Object.freeze(['create', 'update', 'delete']);
const CHANGE_VERBS = Object.freeze({ create: 'created', update: 'updated', delete: 'deleted' });

function toPosix(value) {
  return String(value == null ? '' : value).split('\\').join('/');
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// --- Ignore rules ---------------------------------------------------------

/**
 * The `ignore` array for @parcel/watcher. A bare name only matches at the watched root (verified against
 * 2.6.0), so every name also ships as the two glob forms that reach a nested copy: the directory itself
 * and everything under it.
 */
function buildIgnorePatterns(extraDirNames = []) {
  const names = [];
  for (const raw of [...IGNORED_DIR_NAMES, ...(Array.isArray(extraDirNames) ? extraDirNames : [])]) {
    const name = nonEmptyString(raw);
    if (!name || names.includes(name)) continue;
    names.push(name);
  }
  const patterns = [];
  for (const name of names) patterns.push(name, `**/${name}`, `**/${name}/**`);
  for (const suffix of IGNORED_FILE_SUFFIXES) patterns.push(`**/*${suffix}`);
  for (const name of IGNORED_FILE_NAMES) patterns.push(`**/${name}`);
  return patterns;
}

function hasIgnoredSegment(relPath) {
  for (const segment of toPosix(relPath).split('/')) {
    if (!segment) continue;
    if (IGNORED_DIR_NAMES.includes(segment)) return true;
  }
  return false;
}

function isIgnoredFileName(base) {
  if (IGNORED_FILE_NAMES.includes(base)) return true;
  return IGNORED_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

/**
 * What the daemon writes, derived from the one path it already knows: the exact siblings it owns by name,
 * plus the PREFIX rule that covers everything config-store derives from the config file's own name.
 *
 * The prefix half is not a nicety. Every content-changing save writes `<config>.bak`, boot writes
 * `<config>.boot.bak`, a parse failure writes `<config>.invalid.bak`, and every save stages through
 * `<config>.tmp.<pid>` before its rename. None of those is a path an exact list can hold (the pid is new
 * each run) and none is inside the config file, so an exact-match rule lets a `wasActive` flip publish
 * `updated config.json.bak`. The prefix is `<basename>.` and the directory must match, so a repo file
 * named `configuration.json` or `config.json5` beside it is still real activity.
 *
 * Null when there is no config path, so a source constructed without one keeps the segment rules and
 * nothing else rather than guessing at a directory.
 */
function daemonWriteRules(configPath) {
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

// A sibling of the config file whose name config-store derived from it: a backup, a boot copy, an invalid
// copy, or the per-pid temp file a save stages through.
function isDaemonDerivedSibling(rules, absolutePath) {
  const resolved = path.resolve(absolutePath);
  if (foldCase(path.dirname(resolved)) !== foldCase(rules.dir)) return false;
  return foldCase(path.basename(resolved)).startsWith(foldCase(rules.prefix));
}

function foldCase(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

/**
 * True when `child` is `parent` itself or lives under it. Case-folded on Windows only, for the same
 * reason shared/paths.js folds there: two producers routinely spell one directory two ways, and folding
 * elsewhere would silently equate paths a case-sensitive filesystem keeps apart.
 */
function isPathInside(parent, child) {
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

/**
 * The relative path of a watcher event inside its root, POSIX-spelled, or null when the event names
 * something outside the root at all (a watcher reporting the root's own parent on a rename, which the
 * shell must drop rather than publish as an empty path).
 */
function relativeWithin(root, absolutePath) {
  const from = nonEmptyString(root);
  const to = nonEmptyString(absolutePath);
  if (!from || !to) return null;
  const relative = path.relative(path.resolve(from), path.resolve(to));
  if (!relative || path.isAbsolute(relative)) return null;
  const posix = toPosix(relative);
  if (posix.startsWith('../')) return null;
  return posix;
}

/**
 * Whether a change is noise. The segment and filename rules cover what the watcher's own ignore already
 * handles (defense in depth, and the one place a platform whose glob matching differs still lands right);
 * the daemon rules cover the state files glissa writes into whichever directory its config resolved to.
 */
function isIgnoredChange({ relPath, absolutePath = null, daemonRules = null } = {}) {
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

// --- Roots ----------------------------------------------------------------

/**
 * `sources.fs.roots` from config: strings only, trimmed, deduped by spelling, capped. Canonicalization is
 * deliberately NOT done here, because it is sync `realpathSync.native` and belongs to the shell that owns
 * a filesystem; this only normalizes the shape a hand-edited config can be in.
 */
function normalizeRoots(raw) {
  if (!Array.isArray(raw)) return [];
  const roots = [];
  for (const entry of raw) {
    const value = nonEmptyString(entry);
    if (!value || roots.includes(value)) continue;
    roots.push(value);
    if (roots.length >= MAX_ROOT_ENTRIES) break;
  }
  return roots;
}

/**
 * The subscription set for a wanted set of canonical roots: duplicates gone and every root that lives
 * inside another one dropped. Nesting is the whole point: a project root and a session subdirectory of it
 * are one watch, and subscribing to both would report every change under the child twice, which reads on
 * the wire and in the digest as two separate edits to one file.
 *
 * Shortest first, so the survivor is always the widest root rather than whichever one was named first.
 */
function dedupeRoots(roots) {
  const named = [];
  for (const entry of Array.isArray(roots) ? roots : []) {
    const value = nonEmptyString(entry);
    if (!value) continue;
    if (named.some((kept) => foldCase(path.resolve(kept)) === foldCase(path.resolve(value)))) continue;
    named.push(value);
  }
  named.sort((left, right) => left.length - right.length || left.localeCompare(right));
  const kept = [];
  for (const root of named) {
    if (kept.some((outer) => isPathInside(outer, root))) continue;
    kept.push(root);
  }
  return kept;
}

/**
 * The directories one session contributes. Both halves of a worktree session count, exactly as the git
 * source counts them: the agent edits in the worktree while merges land in the project checkout, and
 * neither directory can see the other's writes.
 */
function deriveSessionRoots(session) {
  const dirs = [];
  for (const dir of [session?.path, session?.worktreeDir]) {
    const value = nonEmptyString(dir);
    if (!value || dirs.includes(value)) continue;
    dirs.push(value);
  }
  return dirs;
}

function isActiveSessionState(state) {
  return ACTIVE_SESSION_STATES.includes(nonEmptyString(state) || '');
}

// --- Batching -------------------------------------------------------------

function createBatch() {
  return { files: new Map(), untracked: new Set(), floored: false };
}

// A short digest of a path, held instead of the path itself once a window is past the point where names
// are worth keeping. 64 bits over at most 10000 entries makes a collision (one file counted as a repeat)
// vanishingly unlikely, and the consequence of one would be a burst total off by one.
function untrackedKey(relPath) {
  return crypto.createHash('sha1').update(relPath, 'utf8').digest('hex').slice(0, UNTRACKED_KEY_CHARS);
}

// A path too long to hold in full, marked as truncated so the published summary cannot be read as naming
// an exact file. Paths this long are pathological; the marker is what keeps one from lying quietly.
function truncatePath(relPath) {
  if (relPath.length <= MAX_REL_PATH_CHARS) return relPath;
  return `${relPath.slice(0, MAX_REL_PATH_CHARS)}${TRUNCATED_SUFFIX}`;
}

function normalizeChangeKind(type) {
  const kind = nonEmptyString(type);
  if (!kind || !CHANGE_KINDS.includes(kind)) return null;
  return kind;
}

/**
 * Two changes to one file inside one window, as one. The interesting rows are the pairs an atomic save
 * produces: a create followed by a delete is a temp file that no longer exists and is dropped entirely,
 * and a delete followed by a create is a file that was REPLACED, which is an update rather than two
 * events claiming the file both vanished and appeared.
 */
function mergeChange(previous, next) {
  if (!previous) return next;
  if (previous === 'create' && next === 'delete') return null;
  if (next === 'delete') return 'delete';
  if (previous === 'create') return 'create';
  return 'update';
}

/**
 * Fold one watcher event into a batch. Returns false for anything the batch refused (ignored path,
 * unknown change kind), so the shell can tell a dropped storm from a recorded one.
 */
function recordChange(batch, relPath, type) {
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
    // Distinct FILES, never events: one written file arrives as a create and an update, and counting
    // both would report a 3000-file checkout as 6000.
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

function batchSize(batch) {
  return batch.files.size + batch.untracked.size;
}

function fileChangeEvent({ root, relPath, change, now }) {
  return {
    source: SOURCE,
    kind: KIND,
    ts: now,
    scope: { root, sessionId: null },
    summary: `${CHANGE_VERBS[change]} ${relPath}`,
    detail: { path: relPath, change },
  };
}

function countByKind(batch) {
  const counts = { create: 0, update: 0, delete: 0 };
  for (const change of batch.files.values()) counts[change] += 1;
  return counts;
}

function burstSummary(batch) {
  const counts = countByKind(batch);
  const parts = [];
  if (counts.create) parts.push(`${counts.create} created`);
  if (counts.update) parts.push(`${counts.update} updated`);
  if (counts.delete) parts.push(`${counts.delete} deleted`);
  const total = batchSize(batch);
  const tail = parts.length > 0 ? `: ${parts.join(', ')}` : '';
  // Past the untracked bound the batch can no longer tell a new file from a repeat, so it reports what it
  // can still stand behind: a floor, said out loud rather than a total that is quietly short.
  const lead = batch.floored ? `at least ${total}` : `${total}`;
  return { summary: `${lead} files changed${tail}`, counts, total };
}

// Newest names are no better than oldest ones here, so insertion order is kept: it is the order the
// watcher reported, which is the closest thing to the order the work happened in.
function sampleOf(batch) {
  return [...batch.files.keys()].slice(0, MAX_SAMPLE_FILES).join(', ');
}

/**
 * What a settled window owes, and nothing more.
 *
 * Under the file threshold each file gets its own line, which is what makes an ordinary edit readable.
 * Over it the window was a burst (an install, a checkout, a build), and one summarized event carries it:
 * the alternative is thousands of ring entries evicting everything else in the fs ring and thousands of
 * seq stamps telling the navigator the machine moved thousands of times for one action.
 */
function decideFsEvents(batch, { root = null, now = 0 } = {}) {
  const total = batchSize(batch);
  if (total === 0) return [];
  if (total <= MAX_FILES_PER_BATCH && batch.untracked.size === 0) {
    const events = [];
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
      // True means `files` is a floor rather than a count, so a reader is never told an exact number the
      // batch could not stand behind.
      atLeast: batch.floored,
      created: counts.create,
      updated: counts.update,
      deleted: counts.delete,
      sample: sampleOf(batch),
    },
  }];
}

module.exports = {
  DEFAULT_BATCH_MS,
  IGNORED_DIR_NAMES,
  IGNORED_FILE_NAMES,
  IGNORED_FILE_SUFFIXES,
  KIND,
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
