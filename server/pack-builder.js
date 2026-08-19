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

const { glissaHomeDir } = require('./config-store');
const { PACK_NAME_RE, matchesGlob, planPackBuild, sourcePattern, validatePackSpec } = require('./core/pack-core');

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

/** A pattern starting with `**` is a suffix matcher and stays as written; anything else is anchored to baseDir. */
function resolvePattern(pattern, baseDir) {
  if (pattern.startsWith('**')) return pattern;
  if (path.isAbsolute(pattern)) return toPosix(path.resolve(pattern));
  return toPosix(path.resolve(baseDir, pattern));
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

async function readFilesForSource(source, sourceIndex, baseDir) {
  const resolved = resolvePattern(sourcePattern(source), baseDir);
  const excludes = (source.exclude || []).map((pattern) => resolvePattern(pattern, baseDir));
  const { candidates, isLiteral } = await candidatesFor(resolved);

  const matched = candidates.filter((full) => {
    if (!isLiteral && !matchesGlob(resolved, full)) return false;
    return !excludes.some((pattern) => matchesGlob(pattern, full));
  });

  const files = [];
  for (const full of matched) {
    files.push({
      relPath: displayPath(full, baseDir),
      content: await fsp.readFile(full, 'utf8'),
      sourceIndex,
    });
  }
  return files;
}

async function readFilesForSkill(skill, skillIndex, baseDir) {
  const root = resolvePattern(skill.dir, baseDir);
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

/** Publish a finished build: write into a tmp sibling, rotate current to previous, then rename in. */
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
async function buildPack({ specPath, baseDir = DEFAULT_PACKS_DIR, builtRoot = defaultBuiltRoot(), now = Date.now } = {}) {
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
      files.push(...(await readFilesForSource(source, index, baseDir)));
    }
    for (const [index, skill] of (spec.skills || []).entries()) {
      files.push(...(await readFilesForSkill(skill, index, baseDir)));
    }
  } catch (err) {
    return failure(spec.name, specPath, [`could not read sources: ${err.message}`]);
  }

  const plan = planPackBuild(spec, files, { builtAt: new Date(now()).toISOString() });
  if (!plan.ok) return failure(spec.name, specPath, plan.errors);

  const currentDir = await publishBuild(builtRoot, spec.name, plan.outputs);
  return buildReport(spec.name, specPath, {
    ok: true,
    version: plan.manifest.version,
    fileCount: plan.outputs.length,
    tokenEstimate: plan.manifest.tokenEstimate,
    budgetTokens: plan.manifest.budgetTokens,
    currentDir,
  });
}

/** Build every spec, or just the named one. Reports per pack; never throws. */
async function buildPacks({ name = null, specsDir = defaultSpecsDir(), baseDir = DEFAULT_PACKS_DIR, builtRoot = defaultBuiltRoot(), now = Date.now } = {}) {
  const specs = await listPackSpecs({ specsDir });
  const wanted = name ? specs.filter((spec) => spec.name === name) : specs;
  if (name && wanted.length === 0) {
    return [failure(name, path.join(specsDir, `${name}${SPEC_SUFFIX}`), [`no spec named "${name}" in ${specsDir}`])];
  }
  const reports = [];
  for (const spec of wanted) {
    reports.push(await buildPack({ specPath: spec.specPath, baseDir, builtRoot, now }));
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
async function readBuiltManifest(name, { builtRoot = defaultBuiltRoot() } = {}) {
  try {
    const raw = await fsp.readFile(path.join(builtRoot, name, 'current', 'manifest.json'), 'utf8');
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

  const currentDir = path.join(builtRoot, name, 'current');
  const stats = await statOrNull(currentDir);
  if (!stats || !stats.isDirectory()) return skip(`not built (no ${currentDir})`);

  const manifest = await readBuiltManifest(name, { builtRoot });
  if (!manifest || typeof manifest.version !== 'string') return skip(`manifest.json missing or unreadable in ${currentDir}`);
  return { name, dir: currentDir, version: manifest.version, reason: null };
}

module.exports = {
  DEFAULT_PACKS_DIR,
  SPEC_SUFFIX,
  buildPack,
  buildPacks,
  defaultBuiltRoot,
  defaultSpecsDir,
  describePackSpec,
  listPackSpecs,
  loadPackSpec,
  readBuiltManifest,
  resolveBuiltPack,
};
