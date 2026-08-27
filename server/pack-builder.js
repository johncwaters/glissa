'use strict';

// IO shell around server/core/pack-core.js: find spec files, walk their source globs, read the files,
// hand everything to the pure planner, and write the result atomically under <packsRoot>/built/<name>/.
//
// Specs and shared sources are version-controlled inside the install (packs/), built output is runtime
// state under ~/.glissa (writable even when the install dir is not). Fully async: this is a cold path,
// but every session shares one event loop and a pack can span a large docs tree.

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');

const { glissaHomeDir, resolveConfigPath } = require('./config-store');
const { GLISSA_HOME_PLACEHOLDER, PACK_NAME_RE, PROJECT_SLUG_PLACEHOLDER, isDataSource, isPackRelativePath, matchesGlob, packTmpOwnerPid, planPackBuild, planPackVariants, sha256, shouldReclaimPackArtifact, sourcePattern, validatePackSpec } = require('./core/pack-core');
const {
  CURRENT_POINTER_DIRECTORY,
  CURRENT_POINTER_FILE,
  PACK_VERSION_RE,
  VERSIONS_DIRECTORY,
  packVersionDirectory,
  parsePackPointer,
  renderPackPointer,
} = require('../session/core/pack-pointer-core');

const SPEC_SUFFIX = '.pack.json';
// Source patterns resolve against packs/, so a shared spec reads the same whether it runs from a repo
// checkout or a global install.
const DEFAULT_PACKS_DIR = path.join(__dirname, '..', 'packs');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const TMP_PREFIX = 'tmp-';
const PUBLISH_LOCK_FILE = 'publish.lock';
const PUBLISH_LOCK_RETRY_MS = 20;
const PUBLISH_ARTIFACT_STALE_MS = 5 * 60 * 1000;
const RETAINED_PACK_VERSIONS = 2;
let publishLockReclaimCounter = 0;

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function defaultSpecsDir() {
  return path.join(DEFAULT_PACKS_DIR, 'specs');
}

function defaultBuiltRoot() {
  return path.join(glissaHomeDir(), 'packs', 'built');
}

/*
 * The one runtime path a version-controlled spec may name: `{{glissaHome}}` is the directory config.json
 * lives in (docs/plan-visions-3.md, M16), which is where the memory projection and every other config
 * sibling sits. THE single derivation, used by the server and the CLI alike: bin/glissa.js bridges
 * --config into GLISSA_CONFIG before dispatching a pack command, so both resolve the same file. Lazy,
 * so a spec that never names the placeholder never asks where the config is.
 */
function defaultGlissaHome() {
  return path.dirname(resolveConfigPath());
}

/** @param {string} pattern @param {string|null} glissaHome @param {string|null} [projectSlug] */
function expandPlaceholders(pattern, glissaHome, projectSlug = null) {
  let expanded = pattern;
  if (expanded.includes(GLISSA_HOME_PLACEHOLDER)) {
    const home = toPosix(path.resolve(glissaHome || defaultGlissaHome()));
    expanded = expanded.split(GLISSA_HOME_PLACEHOLDER).join(home);
  }
  // Resolved once per DERIVED pack, so a built pack dir holds no placeholder and no delivery-time lookup.
  if (projectSlug) expanded = expanded.split(PROJECT_SLUG_PLACEHOLDER).join(projectSlug);
  return expanded;
}

/** @param {string|null} [glissaHome] @param {string|null} [projectSlug] */
function resolvePattern(rawPattern, baseDir, glissaHome = null, projectSlug = null) {
  const pattern = expandPlaceholders(rawPattern, glissaHome, projectSlug);
  if (path.isAbsolute(pattern)) return toPosix(path.resolve(pattern));
  return toPosix(path.resolve(baseDir, pattern));
}

/*
 * The resolved-path re-check under the placeholder, the same shape distillOutputPath applies to a
 * distill output: spec validation already refuses a `..` segment, and this is the layer that holds
 * whatever the resolution actually produced.
 */
function assertInsideGlissaHome(rawPattern, resolved, glissaHome) {
  if (!rawPattern.includes(GLISSA_HOME_PLACEHOLDER)) return;
  const home = path.resolve(glissaHome || defaultGlissaHome());
  // An empty relative path is the config dir itself, which is inside it.
  const relative = path.relative(home, resolved.replace(/\/+$/, ''));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return;
  throw new Error(`source pattern "${rawPattern}" resolves outside the Glissa config directory`);
}

/*
 * Where a data file's delivered path is measured from: the pattern's glob-free root, or its parent when
 * that root IS the one file matched. Never displayPath, whose fallback for a file outside packs/ is the
 * absolute path, which would print the operator's home directory into the pack and the manifest.
 */
function dataBaseDir(resolvedPattern, isLiteral, matched) {
  const rootPosix = toPosix(path.resolve(literalRoot(resolvedPattern).root));
  if (isLiteral && matched.length === 1 && matched[0] === rootPosix) return path.dirname(rootPosix);
  return rootPosix;
}

/** The deepest glob-free prefix of a pattern: where the walk starts, and whether there is a glob at all. */
function literalRoot(resolvedPattern) {
  const segments = resolvedPattern.split('/');
  const literal = [];
  for (const segment of segments) {
    if (segment.includes('*') || segment.includes('?')) break;
    literal.push(segment);
  }
  return { root: literal.join('/'), isLiteral: literal.length === segments.length };
}

async function statOrNull(target) {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

async function walkFiles(rootDir, found = [], visitedRealDirs = new Set()) {
  // Dirent.isSymbolicLink does not flag Windows junctions on every Node version, so the resolved-path
  // set is the loop guard that always holds; a pack build must terminate unattended.
  let realDir;
  try {
    realDir = await fsp.realpath(rootDir);
  } catch {
    return found;
  }
  if (visitedRealDirs.has(realDir)) return found;
  visitedRealDirs.add(realDir);

  let entries;
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return found;
  }
  entries.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkFiles(full, found, visitedRealDirs);
      continue;
    }
    if (!entry.isFile()) continue;
    found.push(toPosix(full));
  }
  return found;
}

function specRootPatterns(spec, { includeDistill = false } = {}) {
  const patterns = [];
  for (const source of Array.isArray(spec?.sources) ? spec.sources : []) patterns.push(sourcePattern(source));
  for (const skill of Array.isArray(spec?.skills) ? spec.skills : []) patterns.push(skill?.dir);
  for (const entry of includeDistill && Array.isArray(spec?.distill) ? spec.distill : []) {
    for (const source of Array.isArray(entry?.sources) ? entry.sources : []) patterns.push(sourcePattern(source));
  }
  return patterns.filter((pattern) => typeof pattern === 'string' && pattern.length > 0);
}

// A per-project pattern is watched as a WILDCARD: a slug-shaped literal would watch nothing when that one project's file is absent.
async function packWatchRoots(spec, { baseDir = DEFAULT_PACKS_DIR, glissaHome = null } = {}) {
  const roots = new Set();
  for (const pattern of specRootPatterns(spec)) {
    const { root } = literalRoot(resolvePattern(pattern, baseDir, glissaHome, '*'));
    if (!root) continue;
    const stats = await statOrNull(root);
    if (!stats) continue;
    const full = path.resolve(root);
    roots.add(toPosix(stats.isDirectory() ? full : path.dirname(full)));
  }
  return [...roots].sort();
}

// Distill sources count: a distill is still a copy of what it read.
function packSourceRoots(spec, { baseDir = DEFAULT_PACKS_DIR, glissaHome = null } = {}) {
  const roots = new Set();
  for (const pattern of specRootPatterns(spec, { includeDistill: true })) {
    const { root } = literalRoot(resolvePattern(pattern, baseDir, glissaHome));
    if (root) roots.add(toPosix(path.resolve(root)));
  }
  return [...roots].sort();
}

// Packs-relative (even climbing out of packs/) so the manifest ships no absolute path; glissaHome roots dropped.
function manifestSourceRoots(spec, { baseDir = DEFAULT_PACKS_DIR, glissaHome = null } = {}) {
  const home = toPosix(path.resolve(glissaHome || defaultGlissaHome()));
  const recorded = new Set();
  for (const root of packSourceRoots(spec, { baseDir, glissaHome })) {
    if (root === home || root.startsWith(`${home}/`)) continue;
    const relative = toPosix(path.relative(baseDir, root));
    recorded.add(relative && !path.isAbsolute(relative) ? relative : root);
  }
  return [...recorded].sort();
}

/** Display path for the manifest: relative to packs/ when the file lives under it, else the full path. */
function displayPath(fullPosix, baseDir) {
  const relative = path.relative(baseDir, fullPosix);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return fullPosix;
  return toPosix(relative);
}

async function candidatesFor(resolvedPattern) {
  const { root, isLiteral } = literalRoot(resolvedPattern);
  if (!isLiteral) return { candidates: await walkFiles(root), isLiteral };
  const stats = await statOrNull(root);
  if (!stats) return { candidates: [], isLiteral };
  if (stats.isDirectory()) return { candidates: await walkFiles(root), isLiteral };
  return { candidates: [toPosix(path.resolve(root))], isLiteral };
}

async function readFilesForSource(source, sourceIndex, baseDir, { keepFullPath = false, glissaHome = null } = {}) {
  const pattern = sourcePattern(source);
  const resolved = resolvePattern(pattern, baseDir, glissaHome);
  assertInsideGlissaHome(pattern, resolved, glissaHome);
  const sourceRoot = literalRoot(resolved).root;
  const excludes = (source.exclude || []).map((entry) => resolvePattern(entry, sourceRoot, glissaHome));
  const { candidates, isLiteral } = await candidatesFor(resolved);

  const matched = candidates.filter((full) => {
    if (!isLiteral && !matchesGlob(resolved, full)) return false;
    return !excludes.some((entry) => matchesGlob(entry, full));
  });

  const dataBase = isDataSource(source) ? dataBaseDir(resolved, isLiteral, matched) : null;
  const files = [];
  for (const full of matched) {
    const file = {
      relPath: dataBase ? toPosix(path.relative(dataBase, full)) : displayPath(full, baseDir),
      sourcePath: displayPath(full, baseDir),
      content: await fsp.readFile(full, 'utf8'),
      sourceIndex,
    };
    // Only the distiller asks for this; a build's file records stay the shape planPackBuild documents.
    if (keepFullPath) file.fullPath = full;
    files.push(file);
  }
  return files;
}

async function readFilesForSkill(skill, skillIndex, baseDir, { glissaHome = null } = {}) {
  const root = resolvePattern(skill.dir, baseDir, glissaHome);
  const files = [];
  for (const full of await walkFiles(root)) {
    files.push({
      relPath: toPosix(path.relative(root, full)),
      sourcePath: displayPath(full, baseDir),
      content: await fsp.readFile(full, 'utf8'),
      skillIndex,
    });
  }
  return files;
}

/**
 * Absolute path of a distill entry's output, or null when lexical escape or an existing symlink could
 * redirect the lane's write outside the packs directory.
 */
async function distillOutputPath(output, { baseDir = DEFAULT_PACKS_DIR } = {}) {
  if (!isPackRelativePath(output)) return null;
  const resolvedBaseDir = path.resolve(baseDir);
  const full = path.resolve(resolvedBaseDir, output);
  const relative = path.relative(resolvedBaseDir, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  let current = resolvedBaseDir;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fsp.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return full;
      return null;
    }
    if (stats.isSymbolicLink()) return null;
  }
  return full;
}

/**
 * Content hashes of one distill entry's sources, walked and hashed through the SAME reader and the
 * same sha256 a build uses, so a drift check and a build can never disagree about what a source says.
 * `path` is the stamped identity (relative to the install root when the file lives inside it, so a
 * stamp committed on one machine still reads as current on another); `fullPath` is what the distill
 * session is told to read.
 *
 * @returns {Promise<Array<{path: string, fullPath: string, sha256: string}>>} sorted, deduped
 */
async function distillSourceHashes(entry, { baseDir = DEFAULT_PACKS_DIR } = {}) {
  const installRoot = path.resolve(baseDir, '..');
  const byStampPath = new Map();
  const sources = Array.isArray(entry.sources) ? entry.sources : [];
  for (const [index, source] of sources.entries()) {
    for (const file of await readFilesForSource(source, index, baseDir, { keepFullPath: true })) {
      const stampPath = displayPath(file.fullPath, installRoot);
      byStampPath.set(stampPath, { path: stampPath, fullPath: file.fullPath, sha256: sha256(file.content) });
    }
  }
  return [...byStampPath.values()].sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
}

async function writeOutputs(targetDir, outputs) {
  const directories = new Set([targetDir]);
  for (const file of outputs) {
    const destination = path.join(targetDir, file.relPath);
    const destinationDir = path.dirname(destination);
    await fsp.mkdir(destinationDir, { recursive: true });
    let directory = destinationDir;
    while (true) {
      directories.add(directory);
      if (directory === targetDir) break;
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`destination ${destination} escaped ${targetDir}`);
      directory = parent;
    }
    const handle = await fsp.open(destination, 'wx', 0o666);
    try {
      await handle.writeFile(file.content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const deepestFirst = [...directories].sort((left, right) => right.length - left.length);
  for (const directory of deepestFirst) await syncDirectory(directory);
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    return true;
  }
}

async function clearStaleTmpDirs(packDir, nowMs = Date.now()) {
  let entries;
  try {
    entries = await fsp.readdir(packDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const artifactPath = path.join(packDir, entry.name);
    if (entry.isFile() && entry.name.startsWith(`${PUBLISH_LOCK_FILE}.reclaimed-`)) {
      await fsp.rm(artifactPath, { force: true });
      continue;
    }
    if (!entry.isDirectory() || !entry.name.startsWith(TMP_PREFIX)) continue;
    const stats = await statOrNull(artifactPath);
    if (!stats) continue;
    const ownerPid = packTmpOwnerPid(entry.name);
    const shouldRemove = shouldReclaimPackArtifact({
      timestampMs: null,
      mtimeMs: stats.mtimeMs,
      nowMs,
      isOwnerAlive: processIsAlive(ownerPid),
      staleMs: PUBLISH_ARTIFACT_STALE_MS,
    });
    if (!shouldRemove) continue;
    await fsp.rm(artifactPath, { recursive: true, force: true });
  }
}

async function readPublishLock(lockPath) {
  let raw;
  let stats;
  try {
    [raw, stats] = await Promise.all([fsp.readFile(lockPath, 'utf8'), fsp.stat(lockPath)]);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  /** @type {{ pid?: unknown, timestamp?: unknown, token?: unknown }|null} */
  let record = null;
  try {
    record = JSON.parse(raw);
  } catch {
    record = null;
  }
  const pid = record?.pid;
  const timestamp = record?.timestamp;
  return {
    raw,
    mtimeMs: stats.mtimeMs,
    pid: typeof pid === 'number' && Number.isSafeInteger(pid) ? pid : null,
    timestampMs: typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : null,
    token: typeof record?.token === 'string' ? record.token : null,
  };
}

async function reclaimPublishLock(lockPath, { now = Date.now } = {}) {
  const observed = await readPublishLock(lockPath);
  if (!observed) return true;
  const shouldReclaim = shouldReclaimPackArtifact({
    timestampMs: observed.timestampMs,
    mtimeMs: observed.mtimeMs,
    nowMs: now(),
    isOwnerAlive: processIsAlive(observed.pid),
    staleMs: PUBLISH_ARTIFACT_STALE_MS,
  });
  if (!shouldReclaim) return false;

  const current = await readPublishLock(lockPath);
  if (!current) return true;
  if (current.raw !== observed.raw) return false;
  publishLockReclaimCounter += 1;
  const reclaimedLockPath = `${lockPath}.reclaimed-${process.pid}-${publishLockReclaimCounter}`;
  try {
    await fsp.rename(lockPath, reclaimedLockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  await fsp.rm(reclaimedLockPath, { force: true });
  return true;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquirePublishLock(packDir, { now = Date.now, sleep = wait } = {}) {
  const lockPath = path.join(packDir, PUBLISH_LOCK_FILE);
  while (true) {
    const token = crypto.randomBytes(12).toString('hex');
    const record = { pid: process.pid, timestamp: now(), token };
    let handle;
    try {
      handle = await fsp.open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.close();
      return { lockPath, token };
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => {});
        await fsp.rm(lockPath, { force: true });
      }
      if (err.code !== 'EEXIST') throw err;
    }
    if (await reclaimPublishLock(lockPath, { now })) continue;
    await sleep(PUBLISH_LOCK_RETRY_MS);
  }
}

async function releasePublishLock({ lockPath, token }) {
  try {
    const current = await readPublishLock(lockPath);
    if (!current || current.token !== token) return;
    await fsp.unlink(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    console.error(`could not release publish lock ${lockPath}: ${err.message}`);
  }
}

function versionForOutputs(outputs, requestedVersion) {
  if (typeof requestedVersion === 'string' && PACK_VERSION_RE.test(requestedVersion)) return requestedVersion;
  const records = [...outputs]
    .map((file) => `${file.relPath}:${sha256(file.content)}`)
    .sort();
  return sha256(records.join('\n'));
}

async function writeCurrentPointer(packDir, version) {
  const pointerText = renderPackPointer(version);
  if (pointerText === null) throw new Error(`invalid pack version "${version}"`);
  const currentDir = path.join(packDir, CURRENT_POINTER_DIRECTORY);
  await fsp.mkdir(currentDir, { recursive: true });
  const pointerPath = path.join(currentDir, CURRENT_POINTER_FILE);
  const tempPath = path.join(currentDir, `${CURRENT_POINTER_FILE}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  /** @type {import('node:fs/promises').FileHandle|null} */
  let handle = null;
  try {
    handle = await fsp.open(tempPath, 'wx', 0o600);
    await handle.writeFile(pointerText, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tempPath, pointerPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function garbageCollectVersions(packDir, pointedVersion) {
  const versionsDir = path.join(packDir, VERSIONS_DIRECTORY);
  let entries;
  try {
    entries = await fsp.readdir(versionsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const versions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PACK_VERSION_RE.test(entry.name)) continue;
    const stats = await statOrNull(path.join(versionsDir, entry.name));
    if (!stats) continue;
    versions.push({ name: entry.name, mtimeMs: stats.mtimeMs });
  }
  versions.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  const kept = new Set([pointedVersion]);
  for (const version of versions) {
    if (kept.size >= RETAINED_PACK_VERSIONS) break;
    kept.add(version.name);
  }
  for (const version of versions) {
    if (kept.has(version.name)) continue;
    await fsp.rm(path.join(versionsDir, version.name), { recursive: true, force: true });
  }
}

// A plain pointer file works on Windows and Linux without symlink privileges.
/**
 * @param {string} builtRoot
 * @param {string} name
 * @param {Array<{ relPath: string, content: string }>} outputs
 * @param {{ now?: () => number, sleep?: (delayMs: number) => Promise<void>, version?: string|null }} [options]
 */
async function publishBuild(builtRoot, name, outputs, { now = Date.now, sleep = wait, version = null } = {}) {
  const packDir = path.join(builtRoot, name);
  await fsp.mkdir(packDir, { recursive: true });
  const lock = await acquirePublishLock(packDir, { now, sleep });
  /** @type {string|null} */
  let tmpDir = null;
  try {
    await clearStaleTmpDirs(packDir);
    const publishedVersion = versionForOutputs(outputs, version);
    const versionsDir = path.join(packDir, VERSIONS_DIRECTORY);
    const versionDir = packVersionDirectory(packDir, publishedVersion);
    if (!versionDir) throw new Error(`invalid pack version "${publishedVersion}"`);
    await fsp.mkdir(versionsDir, { recursive: true });
    const stagedDir = path.join(packDir, `${TMP_PREFIX}${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    tmpDir = stagedDir;
    await fsp.mkdir(stagedDir, { recursive: true });
    await writeOutputs(stagedDir, outputs);
    try {
      await fsp.rename(stagedDir, versionDir);
      tmpDir = null;
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    }
    await syncDirectory(versionsDir);
    await writeCurrentPointer(packDir, publishedVersion);
    try {
      await garbageCollectVersions(packDir, publishedVersion);
    } catch (error) {
      console.error(`could not remove old pack versions from ${packDir}: ${error.message}`);
    }
    return versionDir;
  } finally {
    try {
      if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
    } finally {
      await releasePublishLock(lock);
    }
  }
}

async function loadPackSpec(specPath) {
  const raw = await fsp.readFile(specPath, 'utf8');
  return JSON.parse(raw);
}

/** Every `<name>.pack.json` in the specs dir, sorted by name. */
async function listPackSpecs({ specsDir = defaultSpecsDir() } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(specsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const specs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SPEC_SUFFIX))
    .map((entry) => ({
      name: entry.name.slice(0, -SPEC_SUFFIX.length),
      specPath: path.join(specsDir, entry.name),
    }));
  specs.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
  return specs;
}

/** The one owner of the build-report shape; success and failure differ only in their overrides. */
function buildReport(name, specPath, overrides) {
  return {
    ok: false,
    name,
    specPath,
    errors: [],
    version: null,
    fileCount: 0,
    tokenEstimate: 0,
    budgetTokens: null,
    currentDir: null,
    // True when the planned version already matched the published one, so nothing was written.
    unchanged: false,
    // Derived per-project packs this spec also built (see planPackVariants); empty for a plain spec.
    variants: [],
    warnings: [],
    ...overrides,
  };
}

function failure(name, specPath, errors) {
  return buildReport(name, specPath, { errors });
}

/**
 * Build one pack from its spec file.
 *
 * @param {{ specPath?: string, baseDir?: string, builtRoot?: string, glissaHome?: string | null,
 *   projects?: Array<Record<string, unknown>>, now?: () => number }} [options]
 * @returns {Promise<{ok: boolean, name: string, specPath: string, errors: string[], version: string|null,
 *   fileCount: number, tokenEstimate: number, budgetTokens: number|null, currentDir: string|null,
 *   variants: Array<Record<string, unknown>>, warnings: string[]}>}
 */
async function buildPack({ specPath, baseDir = DEFAULT_PACKS_DIR, builtRoot = defaultBuiltRoot(), glissaHome = null, projects = [], now = Date.now } = {}) {
  if (!specPath) return failure('', '', ['spec path required']);
  const fallbackName = path.basename(specPath).replace(/\.pack\.json$/, '');

  let spec;
  try {
    spec = await loadPackSpec(specPath);
  } catch (err) {
    return failure(fallbackName, specPath, [`could not read spec: ${err.message}`]);
  }

  const specCheck = validatePackSpec(spec);
  if (!specCheck.ok) return failure(fallbackName, specPath, specCheck.errors);
  if (spec.name !== fallbackName) {
    return failure(fallbackName, specPath, [`spec name "${spec.name}" does not match its filename`]);
  }

  // A plain spec plans exactly one build of itself; a perProjectVariants group plans its base plus one
  // derived pack per consuming project, each an independent top-level pack with its own version.
  const plan = planPackVariants(spec, projects);
  const reports = [];
  for (const entry of plan.builds) {
    reports.push(await buildOnePack(entry, { specPath, baseDir, builtRoot, glissaHome, now }));
  }
  const [base, ...variants] = reports;
  return { ...base, variants, warnings: plan.warnings };
}

// One pack's read-plan-publish, run once per entry planPackVariants produced.
async function buildOnePack(entry, { specPath, baseDir, builtRoot, glissaHome, now }) {
  const spec = entry.spec;

  const files = [];
  try {
    for (const [index, source] of spec.sources.entries()) {
      files.push(...(await readFilesForSource(source, index, baseDir, { glissaHome })));
    }
    for (const [index, skill] of (spec.skills || []).entries()) {
      files.push(...(await readFilesForSkill(skill, index, baseDir, { glissaHome })));
    }
  } catch (err) {
    return failure(entry.name, specPath, [`could not read sources: ${err.message}`]);
  }

  const built = planPackBuild(spec, files, {
    builtAt: new Date(now()).toISOString(),
    variant: entry.variant,
    sourceRoots: manifestSourceRoots(spec, { baseDir, glissaHome }),
  });
  if (!built.ok) return failure(entry.name, specPath, built.errors);
  if (!built.manifest) return failure(entry.name, specPath, ['pack build returned no manifest']);

  const report = buildReport(entry.name, specPath, {
    ok: true,
    version: built.manifest.version,
    fileCount: built.outputs.length,
    tokenEstimate: built.manifest.tokenEstimate,
    budgetTokens: built.manifest.budgetTokens,
    currentDir: packVersionDirectory(path.join(builtRoot, entry.name), built.manifest.version),
  });

  // Publish only a version the built dir does not already carry. The watch loop rebuilds on any write
  // under a source root, and Claude Code hot-reloads skills from a delivered pack dir, so rewriting
  // identical bytes would poke every live session for nothing.
  const published = await readBuiltManifest(entry.name, { builtRoot });
  if (published && published.version === built.manifest.version) return { ...report, unchanged: true };

  try {
    await publishBuild(builtRoot, entry.name, built.outputs, { version: built.manifest.version });
  } catch (err) {
    return failure(entry.name, specPath, [`could not publish pack: ${err.message}`]);
  }
  return report;
}

/**
 * Build every spec, or just the named one. Reports per pack; never throws.
 * @param {{ name?: string|null, specsDir?: string, baseDir?: string, builtRoot?: string,
 *   glissaHome?: string|null, projects?: Array<Record<string, unknown>>, now?: () => number }} [options]
 */
async function buildPacks({ name = null, specsDir = defaultSpecsDir(), baseDir = DEFAULT_PACKS_DIR, builtRoot = defaultBuiltRoot(), glissaHome = null, projects = [], now = Date.now } = {}) {
  const specs = await listPackSpecs({ specsDir });
  const wanted = name ? specs.filter((spec) => spec.name === name) : specs;
  if (name && wanted.length === 0) {
    return [failure(name, path.join(specsDir, `${name}${SPEC_SUFFIX}`), [`no spec named "${name}" in ${specsDir}`])];
  }
  const reports = [];
  for (const spec of wanted) {
    try {
      const report = await buildPack({ specPath: spec.specPath, baseDir, builtRoot, glissaHome, projects, now });
      // Derived packs are reported beside their group: each one is its own pack, so a caller listing
      // build results lists them rather than hiding them inside the group's row.
      reports.push(report, ...report.variants);
    } catch (err) {
      reports.push(failure(spec.name, spec.specPath, [`build crashed: ${err.message}`]));
    }
  }
  return reports;
}

/** Load-and-validate summary of one spec file for listings; never throws. */
async function describePackSpec(specPath) {
  try {
    const spec = await loadPackSpec(specPath);
    return {
      valid: validatePackSpec(spec).ok,
      sourceCount: Array.isArray(spec.sources) ? spec.sources.length : 0,
      budgetTokens: typeof spec.budgetTokens === 'number' ? spec.budgetTokens : null,
    };
  } catch {
    return { valid: false, sourceCount: 0, budgetTokens: null };
  }
}

async function readManifestFromDirectory(directory) {
  try {
    const raw = await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function resolveCurrentDirectory(name, builtRoot) {
  const packDir = path.join(builtRoot, name);
  const currentDir = path.join(packDir, CURRENT_POINTER_DIRECTORY);
  const pointerPath = path.join(currentDir, CURRENT_POINTER_FILE);
  /** @type {string|null} */
  let rawPointer = null;
  try {
    rawPointer = await fsp.readFile(pointerPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      return { dir: null, version: null, manifest: null, reason: `current pointer unreadable at ${pointerPath}` };
    }
  }
  if (rawPointer !== null) {
    const version = parsePackPointer(rawPointer);
    if (!version) return { dir: null, version: null, manifest: null, reason: `current pointer invalid at ${pointerPath}` };
    const versionDir = packVersionDirectory(packDir, version);
    const stats = await statOrNull(versionDir);
    if (!stats?.isDirectory()) return { dir: null, version: null, manifest: null, reason: `pointed version missing at ${versionDir}` };
    const manifest = await readManifestFromDirectory(versionDir);
    return { dir: versionDir, version, manifest, reason: null };
  }

  const legacyManifest = await readManifestFromDirectory(currentDir);
  if (legacyManifest && typeof legacyManifest.version === 'string') {
    return { dir: currentDir, version: legacyManifest.version, manifest: legacyManifest, reason: null };
  }
  return { dir: null, version: null, manifest: null, reason: `not built (no pointer at ${pointerPath})` };
}

/** @returns {Promise<({ version: string, projectSlug?: string, projectId?: string, [key: string]: unknown }) | null>} */
async function readBuiltManifest(name, { builtRoot = defaultBuiltRoot() } = {}) {
  if (typeof name !== 'string' || !PACK_NAME_RE.test(name)) return null;
  const current = await resolveCurrentDirectory(name, builtRoot);
  if (!current.dir) return null;
  const { manifest } = current;
  if (!manifest || manifest.version !== current.version) return null;
  return manifest;
}

/**
 * Delivery view of one pack: its pointed immutable version dir plus the version it is running, or a
 * skip reason. Never throws and never guesses: an unbuilt or unreadable pack resolves to dir null.
 *
 * @returns {Promise<{name: string, dir: string|null, version: string|null, reason: string|null,
 *   manifest: Record<string, unknown>|null, perProjectVariants: boolean, group: string|null}>}
 */
async function resolveBuiltPack(name, { builtRoot = defaultBuiltRoot() } = {}) {
  const skip = (reason) => ({ name, dir: null, version: null, reason, manifest: null, perProjectVariants: false, group: null });
  // A pack name comes from config.json and becomes a path segment here, so it is re-checked even
  // though the caller normalizes: a `..` segment would resolve outside the built root.
  if (typeof name !== 'string' || !PACK_NAME_RE.test(name)) return skip('not a valid pack name');

  const current = await resolveCurrentDirectory(name, builtRoot);
  if (!current.dir) return skip(current.reason);
  const { manifest } = current;
  if (!manifest || manifest.version !== current.version) {
    return skip(`manifest.json missing, unreadable, or mismatched in ${current.dir}`);
  }
  return {
    name,
    dir: current.dir,
    version: manifest.version,
    reason: null,
    manifest,
    perProjectVariants: manifest.perProjectVariants === true,
    group: typeof manifest.group === 'string' ? manifest.group : null,
  };
}

module.exports = {
  DEFAULT_PACKS_DIR,
  GLISSA_HOME_PLACEHOLDER,
  SPEC_SUFFIX,
  buildPack,
  buildPacks,
  defaultBuiltRoot,
  defaultGlissaHome,
  defaultSpecsDir,
  describePackSpec,
  distillOutputPath,
  distillSourceHashes,
  listPackSpecs,
  loadPackSpec,
  packSourceRoots,
  packWatchRoots,
  publishBuild,
  readBuiltManifest,
  resolveBuiltPack,
};
