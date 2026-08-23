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
const { GLISSA_HOME_PLACEHOLDER, PACK_NAME_RE, isDataSource, isPackRelativePath, matchesGlob, planPackBuild, sha256, sourcePattern, validatePackSpec } = require('./core/pack-core');

const SPEC_SUFFIX = '.pack.json';
// Source patterns resolve against packs/, so a shared spec reads the same whether it runs from a repo
// checkout or a global install.
const DEFAULT_PACKS_DIR = path.join(__dirname, '..', 'packs');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const TMP_PREFIX = 'tmp-';

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

function expandPlaceholders(pattern, glissaHome) {
  if (!pattern.includes(GLISSA_HOME_PLACEHOLDER)) return pattern;
  const home = toPosix(path.resolve(glissaHome || defaultGlissaHome()));
  return pattern.split(GLISSA_HOME_PLACEHOLDER).join(home);
}

/** A pattern starting with `**` is a suffix matcher and stays as written; anything else is anchored to baseDir. */
function resolvePattern(rawPattern, baseDir, glissaHome = null) {
  const pattern = expandPlaceholders(rawPattern, glissaHome);
  if (pattern.startsWith('**')) return pattern;
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

async function pathExists(target) {
  return (await statOrNull(target)) !== null;
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

/**
 * Directories worth watching for one spec's inputs: each source pattern's glob-free root plus each
 * skill dir (the parent when that root is a single file), deduped, existing ones only. The watch loop
 * asks for these rather than re-deriving them, so the walk and the watch always agree on where a
 * pack's sources live. A root that does not exist yet is simply absent; the interval sweep covers it.
 */
async function packWatchRoots(spec, { baseDir = DEFAULT_PACKS_DIR, glissaHome = null } = {}) {
  const roots = new Set();
  const addRoot = async (pattern) => {
    if (typeof pattern !== 'string' || pattern.length === 0) return;
    const { root } = literalRoot(resolvePattern(pattern, baseDir, glissaHome));
    if (!root) return;
    const stats = await statOrNull(root);
    if (!stats) return;
    const full = path.resolve(root);
    roots.add(toPosix(stats.isDirectory() ? full : path.dirname(full)));
  };
  for (const source of Array.isArray(spec.sources) ? spec.sources : []) await addRoot(sourcePattern(source));
  for (const skill of Array.isArray(spec.skills) ? spec.skills : []) await addRoot(skill.dir);
  return [...roots].sort();
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
  const excludes = (source.exclude || []).map((entry) => resolvePattern(entry, baseDir, glissaHome));
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
      content: await fsp.readFile(full, 'utf8'),
      skillIndex,
    });
  }
  return files;
}

/**
 * Absolute path of a distill entry's output, or null when it would land outside the packs directory.
 * The spec validator already rejects an escaping `output`; this is the resolved-path re-check, because
 * the value names a file an LLM lane is about to write.
 */
function distillOutputPath(output, { baseDir = DEFAULT_PACKS_DIR } = {}) {
  if (!isPackRelativePath(output)) return null;
  const full = path.resolve(baseDir, output);
  const relative = path.relative(baseDir, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
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
  for (const file of outputs) {
    const destination = path.join(targetDir, file.relPath);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, file.content, 'utf8');
  }
}

async function clearStaleTmpDirs(packDir) {
  let entries;
  try {
    entries = await fsp.readdir(packDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TMP_PREFIX)) continue;
    await fsp.rm(path.join(packDir, entry.name), { recursive: true, force: true });
  }
}

/*
 * Publish a finished build: write into a tmp sibling, rotate current to previous, then rename in.
 *
 * The rotation is TWO renames, so there is a window in which no `current/` exists at all - a crash
 * there used to leave the pack unresolvable, which "atomic publish" overstated (2026-08 review,
 * section 8). It cannot be collapsed into one visible swap: Windows cannot atomically replace a
 * non-empty directory by rename. What closes it is the other half of the review's suggestion, in
 * resolveBuiltPack: during that window `previous/` holds the last good build (this rename just put it
 * there), so a delivery that finds no `current/` falls back to it rather than skipping the pack. The
 * order below is deliberate - current is retired to previous BEFORE the tmp goes in - because it is
 * what makes that fallback point at the last good build rather than at nothing.
 */
async function publishBuild(builtRoot, name, outputs) {
  const packDir = path.join(builtRoot, name);
  await fsp.mkdir(packDir, { recursive: true });
  await clearStaleTmpDirs(packDir);

  const tmpDir = path.join(packDir, `${TMP_PREFIX}${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  await writeOutputs(tmpDir, outputs);

  const currentDir = path.join(packDir, 'current');
  const previousDir = path.join(packDir, 'previous');
  if (await pathExists(currentDir)) {
    await fsp.rm(previousDir, { recursive: true, force: true });
    await fsp.rename(currentDir, previousDir);
  }
  await fsp.rename(tmpDir, currentDir);
  return currentDir;
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
    ...overrides,
  };
}

function failure(name, specPath, errors) {
  return buildReport(name, specPath, { errors });
}

/**
 * Build one pack from its spec file.
 *
 * @returns {Promise<{ok: boolean, name: string, specPath: string, errors: string[], version: string|null,
 *   fileCount: number, tokenEstimate: number, budgetTokens: number|null, currentDir: string|null}>}
 */
async function buildPack({ specPath, baseDir = DEFAULT_PACKS_DIR, builtRoot = defaultBuiltRoot(), glissaHome = null, now = Date.now } = {}) {
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

  const files = [];
  try {
    for (const [index, source] of spec.sources.entries()) {
      files.push(...(await readFilesForSource(source, index, baseDir, { glissaHome })));
    }
    for (const [index, skill] of (spec.skills || []).entries()) {
      files.push(...(await readFilesForSkill(skill, index, baseDir, { glissaHome })));
    }
  } catch (err) {
    return failure(spec.name, specPath, [`could not read sources: ${err.message}`]);
  }

  const plan = planPackBuild(spec, files, { builtAt: new Date(now()).toISOString() });
  if (!plan.ok) return failure(spec.name, specPath, plan.errors);

  const report = buildReport(spec.name, specPath, {
    ok: true,
    version: plan.manifest.version,
    fileCount: plan.outputs.length,
    tokenEstimate: plan.manifest.tokenEstimate,
    budgetTokens: plan.manifest.budgetTokens,
    currentDir: path.join(builtRoot, spec.name, 'current'),
  });

  // Publish only a version the built dir does not already carry. The watch loop rebuilds on any write
  // under a source root, and Claude Code hot-reloads skills from a delivered pack dir, so rewriting
  // identical bytes would poke every live session for nothing (and churn current/previous with it).
  const published = await readBuiltManifest(spec.name, { builtRoot });
  if (published && published.version === plan.manifest.version) return { ...report, unchanged: true };

  await publishBuild(builtRoot, spec.name, plan.outputs);
  return report;
}

/** Build every spec, or just the named one. Reports per pack; never throws. */
async function buildPacks({ name = null, specsDir = defaultSpecsDir(), baseDir = DEFAULT_PACKS_DIR, builtRoot = defaultBuiltRoot(), glissaHome = null, now = Date.now } = {}) {
  const specs = await listPackSpecs({ specsDir });
  const wanted = name ? specs.filter((spec) => spec.name === name) : specs;
  if (name && wanted.length === 0) {
    return [failure(name, path.join(specsDir, `${name}${SPEC_SUFFIX}`), [`no spec named "${name}" in ${specsDir}`])];
  }
  const reports = [];
  for (const spec of wanted) {
    reports.push(await buildPack({ specPath: spec.specPath, baseDir, builtRoot, glissaHome, now }));
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

/** The manifest of a pack's current build, or null when it has never been built. */
async function readBuiltManifest(name, { builtRoot = defaultBuiltRoot(), slot = 'current' } = {}) {
  try {
    const raw = await fsp.readFile(path.join(builtRoot, name, slot, 'manifest.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Delivery view of one pack: the `current` dir a spawn may add plus the version it is running, or a
 * skip reason. Never throws and never guesses: an unbuilt or unreadable pack resolves to dir null.
 *
 * @returns {Promise<{name: string, dir: string|null, version: string|null, reason: string|null}>}
 */
async function resolveBuiltPack(name, { builtRoot = defaultBuiltRoot() } = {}) {
  const skip = (reason) => ({ name, dir: null, version: null, reason });
  // A pack name comes from config.json and becomes a path segment here, so it is re-checked even
  // though the caller normalizes: a `..` segment would resolve outside the built root.
  if (typeof name !== 'string' || !PACK_NAME_RE.test(name)) return skip('not a valid pack name');

  /*
   * `current` first, `previous` as the crash fallback. Publishing rotates through two renames, so a
   * crash between them leaves no `current/` while `previous/` still holds the last good build; a
   * delivery that skipped the pack there would silently cost a session its context over a window that
   * is nobody's fault. Delivering the previous build instead is honest and self-healing: the next
   * rebuild republishes `current/` and the staleness chip already reports the version gap.
   */
  const currentDir = path.join(builtRoot, name, 'current');
  let firstRefusal = null;
  for (const slot of ['current', 'previous']) {
    const dir = path.join(builtRoot, name, slot);
    const stats = await statOrNull(dir);
    if (!stats || !stats.isDirectory()) {
      firstRefusal = firstRefusal || `not built (no ${currentDir})`;
      continue;
    }
    const manifest = await readBuiltManifest(name, { builtRoot, slot });
    if (!manifest || typeof manifest.version !== 'string') {
      firstRefusal = firstRefusal || `manifest.json missing or unreadable in ${dir}`;
      continue;
    }
    return { name, dir, version: manifest.version, reason: null };
  }
  // The reason names what was wrong with `current`, which is what an operator is looking for: the
  // previous slot is a crash fallback, not a thing they configured.
  return skip(firstRefusal);
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
  packWatchRoots,
  readBuiltManifest,
  resolveBuiltPack,
};
