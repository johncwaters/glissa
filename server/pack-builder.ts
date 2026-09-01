
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';

import { packsDir } from './runtime-paths.ts';
import {
  CURRENT_POINTER_DIRECTORY,
  CURRENT_POINTER_FILE,
  PACK_VERSION_RE,
  VERSIONS_DIRECTORY,
  packVersionDirectory,
  parsePackPointer,
  renderPackPointer,
} from '../session/core/pack-pointer-core.ts';
import { glissaHomeDir, resolveConfigPath } from './config-store.ts';
import {
  GLISSA_HOME_PLACEHOLDER,
  PACK_NAME_RE,
  PROJECT_SLUG_PLACEHOLDER,
  isDataSource,
  isPackRelativePath,
  matchesGlob,
  packTmpOwnerPid,
  planPackBuild,
  planPackVariants,
  sha256,
  shouldReclaimPackArtifact,
  sourcePattern,
  validatePackSpec,
} from './core/pack-core.ts';
import type { PackInputFile, PackManifest, PackSkill, PackSource, PackSpec, PackVariant } from './core/pack-core.ts';

const SPEC_SUFFIX = '.pack.json';
const DEFAULT_PACKS_DIR = packsDir;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const TMP_PREFIX = 'tmp-';
const PUBLISH_LOCK_FILE = 'publish.lock';
const PUBLISH_LOCK_RETRY_MS = 20;
const PUBLISH_ARTIFACT_STALE_MS = 5 * 60 * 1000;
const RETAINED_PACK_VERSIONS = 2;
let publishLockReclaimCounter = 0;

interface SpecListing {
  name: string;
  specPath: string;
}

interface ReadFile extends PackInputFile {
  sourcePath: string;
  fullPath?: string;
}

interface DistillSourceHash {
  path: string;
  fullPath: string;
  sha256: string;
}

interface PublishLockRecord {
  raw: string;
  mtimeMs: number;
  pid: number | null;
  timestampMs: number | null;
  token: string | null;
}

interface PublishLockHandle {
  lockPath: string;
  token: string;
}

interface BuildReport {
  ok: boolean;
  name: string;
  specPath: string;
  errors: string[];
  version: string | null;
  fileCount: number;
  tokenEstimate: number;
  budgetTokens: number | null;
  currentDir: string | null;
  unchanged: boolean;
  variants: BuildReport[];
  warnings: string[];
}

type ReadManifest = (PackManifest & Record<string, unknown>) | null;

interface ResolvedCurrentDirectory {
  dir: string | null;
  version: string | null;
  manifest: ReadManifest;
  reason: string | null;
}

interface ResolvedBuiltPack {
  name: string;
  dir: string | null;
  version: string | null;
  reason: string | null;
  manifest: ReadManifest;
  perProjectVariants: boolean;
  group: string | null;
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPosix(p: unknown): string {
  return String(p).replace(/\\/g, '/');
}

function defaultSpecsDir(): string {
  return path.join(DEFAULT_PACKS_DIR, 'specs');
}

function defaultBuiltRoot(): string {
  return path.join(glissaHomeDir(), 'packs', 'built');
}

function defaultGlissaHome(): string {
  return path.dirname(resolveConfigPath());
}

function expandPlaceholders(pattern: string, glissaHome: string | null, projectSlug: string | null = null): string {
  let expanded = pattern;
  if (expanded.includes(GLISSA_HOME_PLACEHOLDER)) {
    const home = toPosix(path.resolve(glissaHome || defaultGlissaHome()));
    expanded = expanded.split(GLISSA_HOME_PLACEHOLDER).join(home);
  }
  if (projectSlug) expanded = expanded.split(PROJECT_SLUG_PLACEHOLDER).join(projectSlug);
  return expanded;
}

function resolvePattern(
  rawPattern: string,
  baseDir: string,
  glissaHome: string | null = null,
  projectSlug: string | null = null,
): string {
  const pattern = expandPlaceholders(rawPattern, glissaHome, projectSlug);
  if (path.isAbsolute(pattern)) return toPosix(path.resolve(pattern));
  return toPosix(path.resolve(baseDir, pattern));
}

function assertInsideGlissaHome(rawPattern: string, resolved: string, glissaHome: string | null): void {
  if (!rawPattern.includes(GLISSA_HOME_PLACEHOLDER)) return;
  const home = path.resolve(glissaHome || defaultGlissaHome());
  const relative = path.relative(home, resolved.replace(/\/+$/, ''));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return;
  throw new Error(`source pattern "${rawPattern}" resolves outside the Glissa config directory`);
}

function literalRoot(resolvedPattern: string): { root: string; isLiteral: boolean } {
  const segments = resolvedPattern.split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (segment.includes('*') || segment.includes('?')) break;
    literal.push(segment);
  }
  return { root: literal.join('/'), isLiteral: literal.length === segments.length };
}

function dataBaseDir(resolvedPattern: string, isLiteral: boolean, matched: string[]): string {
  const rootPosix = toPosix(path.resolve(literalRoot(resolvedPattern).root));
  if (isLiteral && matched.length === 1 && matched[0] === rootPosix) return path.dirname(rootPosix);
  return rootPosix;
}

async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

async function walkFiles(
  rootDir: string,
  found: string[] = [],
  visitedRealDirs: Set<string> = new Set(),
): Promise<string[]> {
  let realDir: string;
  try {
    realDir = await fsp.realpath(rootDir);
  } catch {
    return found;
  }
  if (visitedRealDirs.has(realDir)) return found;
  visitedRealDirs.add(realDir);

  let entries: Dirent[];
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function specRootPatterns(spec: unknown, { includeDistill = false } = {}): string[] {
  const source = spec as { sources?: unknown; skills?: unknown; distill?: unknown } | null | undefined;
  const patterns: unknown[] = [];
  for (const entry of asArray(source?.sources)) patterns.push(sourcePattern(entry as PackSource));
  for (const skill of asArray(source?.skills)) patterns.push((skill as PackSkill | null)?.dir);
  const distillEntries = includeDistill ? asArray(source?.distill) : [];
  for (const entry of distillEntries) {
    const sources = (entry as { sources?: unknown } | null)?.sources;
    for (const nested of asArray(sources)) patterns.push(sourcePattern(nested as PackSource));
  }
  return patterns.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0);
}

async function packWatchRoots(
  spec: unknown,
  { baseDir = DEFAULT_PACKS_DIR, glissaHome = null }: { baseDir?: string; glissaHome?: string | null } = {},
): Promise<string[]> {
  const roots = new Set<string>();
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

function packSourceRoots(
  spec: unknown,
  { baseDir = DEFAULT_PACKS_DIR, glissaHome = null }: { baseDir?: string; glissaHome?: string | null } = {},
): string[] {
  const roots = new Set<string>();
  for (const pattern of specRootPatterns(spec, { includeDistill: true })) {
    const { root } = literalRoot(resolvePattern(pattern, baseDir, glissaHome));
    if (root) roots.add(toPosix(path.resolve(root)));
  }
  return [...roots].sort();
}

function manifestSourceRoots(
  spec: unknown,
  { baseDir = DEFAULT_PACKS_DIR, glissaHome = null }: { baseDir?: string; glissaHome?: string | null } = {},
): string[] {
  const home = toPosix(path.resolve(glissaHome || defaultGlissaHome()));
  const recorded = new Set<string>();
  for (const root of packSourceRoots(spec, { baseDir, glissaHome })) {
    if (root === home || root.startsWith(`${home}/`)) continue;
    const relative = toPosix(path.relative(baseDir, root));
    recorded.add(relative && !path.isAbsolute(relative) ? relative : root);
  }
  return [...recorded].sort();
}

function displayPath(fullPosix: string, baseDir: string): string {
  const relative = path.relative(baseDir, fullPosix);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return fullPosix;
  return toPosix(relative);
}

async function candidatesFor(resolvedPattern: string): Promise<{ candidates: string[]; isLiteral: boolean }> {
  const { root, isLiteral } = literalRoot(resolvedPattern);
  if (!isLiteral) return { candidates: await walkFiles(root), isLiteral };
  const stats = await statOrNull(root);
  if (!stats) return { candidates: [], isLiteral };
  if (stats.isDirectory()) return { candidates: await walkFiles(root), isLiteral };
  return { candidates: [toPosix(path.resolve(root))], isLiteral };
}

async function readFilesForSource(
  source: PackSource,
  sourceIndex: number,
  baseDir: string,
  { keepFullPath = false, glissaHome = null }: { keepFullPath?: boolean; glissaHome?: string | null } = {},
): Promise<ReadFile[]> {
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
  const files: ReadFile[] = [];
  for (const full of matched) {
    const file: ReadFile = {
      relPath: dataBase ? toPosix(path.relative(dataBase, full)) : displayPath(full, baseDir),
      sourcePath: displayPath(full, baseDir),
      content: await fsp.readFile(full, 'utf8'),
      sourceIndex,
    };
    if (keepFullPath) file.fullPath = full;
    files.push(file);
  }
  return files;
}

async function readFilesForSkill(
  skill: PackSkill,
  skillIndex: number,
  baseDir: string,
  { glissaHome = null }: { glissaHome?: string | null } = {},
): Promise<ReadFile[]> {
  const root = resolvePattern(skill.dir, baseDir, glissaHome);
  const files: ReadFile[] = [];
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

async function distillOutputPath(
  output: unknown,
  { baseDir = DEFAULT_PACKS_DIR }: { baseDir?: string } = {},
): Promise<string | null> {
  if (!isPackRelativePath(output)) return null;
  const resolvedBaseDir = path.resolve(baseDir);
  const full = path.resolve(resolvedBaseDir, String(output));
  const relative = path.relative(resolvedBaseDir, full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  let current = resolvedBaseDir;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stats: Stats;
    try {
      stats = await fsp.lstat(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return full;
      return null;
    }
    if (stats.isSymbolicLink()) return null;
  }
  return full;
}

async function distillSourceHashes(
  entry: { sources?: unknown },
  { baseDir = DEFAULT_PACKS_DIR }: { baseDir?: string } = {},
): Promise<DistillSourceHash[]> {
  const installRoot = path.resolve(baseDir, '..');
  const byStampPath = new Map<string, DistillSourceHash>();
  const sources: PackSource[] = Array.isArray(entry.sources) ? entry.sources : [];
  for (const [index, source] of sources.entries()) {
    for (const file of await readFilesForSource(source, index, baseDir, { keepFullPath: true })) {
      const fullPath = file.fullPath;
      if (!fullPath) continue;
      const stampPath = displayPath(fullPath, installRoot);
      byStampPath.set(stampPath, { path: stampPath, fullPath, sha256: sha256(file.content) });
    }
  }
  return [...byStampPath.values()].sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeOutputs(targetDir: string, outputs: { relPath: string; content: string }[]): Promise<void> {
  const directories = new Set<string>([targetDir]);
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

function processIsAlive(pid: number | null): boolean | null {
  if (!Number.isSafeInteger(pid) || pid === null || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (errorCode(err) === 'ESRCH') return false;
    return true;
  }
}

async function clearStaleTmpDirs(packDir: string, nowMs: number = Date.now()): Promise<void> {
  let entries: Dirent[];
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

async function readPublishLock(lockPath: string): Promise<PublishLockRecord | null> {
  let raw: string;
  let stats: Stats;
  try {
    [raw, stats] = await Promise.all([fsp.readFile(lockPath, 'utf8'), fsp.stat(lockPath)]);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw err;
  }
  let record: { pid?: unknown; timestamp?: unknown; token?: unknown } | null = null;
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

async function reclaimPublishLock(lockPath: string, { now = Date.now }: { now?: () => number } = {}): Promise<boolean> {
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
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
  await fsp.rm(reclaimedLockPath, { force: true });
  return true;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquirePublishLock(
  packDir: string,
  { now = Date.now, sleep = wait }: { now?: () => number; sleep?: (delayMs: number) => Promise<void> } = {},
): Promise<PublishLockHandle> {
  const lockPath = path.join(packDir, PUBLISH_LOCK_FILE);
  while (true) {
    const token = crypto.randomBytes(12).toString('hex');
    const record = { pid: process.pid, timestamp: now(), token };
    let handle: fsp.FileHandle | undefined;
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
      if (errorCode(err) !== 'EEXIST') throw err;
    }
    if (await reclaimPublishLock(lockPath, { now })) continue;
    await sleep(PUBLISH_LOCK_RETRY_MS);
  }
}

async function releasePublishLock({ lockPath, token }: PublishLockHandle): Promise<void> {
  try {
    const current = await readPublishLock(lockPath);
    if (!current || current.token !== token) return;
    await fsp.unlink(lockPath);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
    console.error(`could not release publish lock ${lockPath}: ${errorMessage(err)}`);
  }
}

function versionForOutputs(outputs: { relPath: string; content: string }[], requestedVersion: string | null): string {
  if (typeof requestedVersion === 'string' && PACK_VERSION_RE.test(requestedVersion)) return requestedVersion;
  const records = [...outputs]
    .map((file) => `${file.relPath}:${sha256(file.content)}`)
    .sort();
  return sha256(records.join('\n'));
}

async function writeCurrentPointer(packDir: string, version: string): Promise<void> {
  const pointerText = renderPackPointer(version);
  if (pointerText === null) throw new Error(`invalid pack version "${version}"`);
  const currentDir = path.join(packDir, CURRENT_POINTER_DIRECTORY);
  await fsp.mkdir(currentDir, { recursive: true });
  const pointerPath = path.join(currentDir, CURRENT_POINTER_FILE);
  const tempPath = path.join(currentDir, `${CURRENT_POINTER_FILE}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let handle: fsp.FileHandle | null = null;
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

async function garbageCollectVersions(packDir: string, pointedVersion: string): Promise<void> {
  const versionsDir = path.join(packDir, VERSIONS_DIRECTORY);
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(versionsDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  const versions: { name: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PACK_VERSION_RE.test(entry.name)) continue;
    const stats = await statOrNull(path.join(versionsDir, entry.name));
    if (!stats) continue;
    versions.push({ name: entry.name, mtimeMs: stats.mtimeMs });
  }
  versions.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  const kept = new Set<string>([pointedVersion]);
  for (const version of versions) {
    if (kept.size >= RETAINED_PACK_VERSIONS) break;
    kept.add(version.name);
  }
  for (const version of versions) {
    if (kept.has(version.name)) continue;
    await fsp.rm(path.join(versionsDir, version.name), { recursive: true, force: true });
  }
}

async function publishBuild(
  builtRoot: string,
  name: string,
  outputs: { relPath: string; content: string }[],
  { now = Date.now, sleep = wait, version = null }: {
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
    version?: string | null;
  } = {},
): Promise<string> {
  const packDir = path.join(builtRoot, name);
  await fsp.mkdir(packDir, { recursive: true });
  const lock = await acquirePublishLock(packDir, { now, sleep });
  let tmpDir: string | null = null;
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
      if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'ENOTEMPTY') throw error;
    }
    await syncDirectory(versionsDir);
    await writeCurrentPointer(packDir, publishedVersion);
    try {
      await garbageCollectVersions(packDir, publishedVersion);
    } catch (error) {
      console.error(`could not remove old pack versions from ${packDir}: ${errorMessage(error)}`);
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

async function loadPackSpec(specPath: string): Promise<unknown> {
  const raw = await fsp.readFile(specPath, 'utf8');
  return JSON.parse(raw);
}

async function listPackSpecs({ specsDir = defaultSpecsDir() }: { specsDir?: string } = {}): Promise<SpecListing[]> {
  let entries: Dirent[];
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

function buildReport(name: string, specPath: string, overrides: Partial<BuildReport>): BuildReport {
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
    unchanged: false,
    variants: [],
    warnings: [],
    ...overrides,
  };
}

function failure(name: string, specPath: string, errors: string[]): BuildReport {
  return buildReport(name, specPath, { errors });
}

async function readManifestFromDirectory(directory: string): Promise<ReadManifest> {
  try {
    const raw = await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function resolveCurrentDirectory(name: string, builtRoot: string): Promise<ResolvedCurrentDirectory> {
  const packDir = path.join(builtRoot, name);
  const currentDir = path.join(packDir, CURRENT_POINTER_DIRECTORY);
  const pointerPath = path.join(currentDir, CURRENT_POINTER_FILE);
  let rawPointer: string | null = null;
  try {
    rawPointer = await fsp.readFile(pointerPath, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') {
      return { dir: null, version: null, manifest: null, reason: `current pointer unreadable at ${pointerPath}` };
    }
  }
  if (rawPointer !== null) {
    const version = parsePackPointer(rawPointer);
    if (!version) return { dir: null, version: null, manifest: null, reason: `current pointer invalid at ${pointerPath}` };
    const versionDir = packVersionDirectory(packDir, version);
    const stats = versionDir ? await statOrNull(versionDir) : null;
    if (!versionDir || !stats?.isDirectory()) return { dir: null, version: null, manifest: null, reason: `pointed version missing at ${versionDir}` };
    const manifest = await readManifestFromDirectory(versionDir);
    return { dir: versionDir, version, manifest, reason: null };
  }

  const legacyManifest = await readManifestFromDirectory(currentDir);
  if (legacyManifest && typeof legacyManifest.version === 'string') {
    return { dir: currentDir, version: legacyManifest.version, manifest: legacyManifest, reason: null };
  }
  return { dir: null, version: null, manifest: null, reason: `not built (no pointer at ${pointerPath})` };
}

async function readBuiltManifest(
  name: unknown,
  { builtRoot = defaultBuiltRoot() }: { builtRoot?: string } = {},
): Promise<PackManifest | null> {
  if (typeof name !== 'string' || !PACK_NAME_RE.test(name)) return null;
  const current = await resolveCurrentDirectory(name, builtRoot);
  if (!current.dir) return null;
  const { manifest } = current;
  if (!manifest || manifest.version !== current.version) return null;
  return manifest;
}

async function resolveBuiltPack(
  name: unknown,
  { builtRoot = defaultBuiltRoot() }: { builtRoot?: string } = {},
): Promise<ResolvedBuiltPack> {
  const packName = typeof name === 'string' ? name : '';
  const skip = (reason: string | null): ResolvedBuiltPack => ({
    name: packName, dir: null, version: null, reason, manifest: null, perProjectVariants: false, group: null,
  });
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

async function buildOnePack(
  entry: { name: string; spec: PackSpec; variant: PackVariant | null },
  { specPath, baseDir, builtRoot, glissaHome, now }: {
    specPath: string;
    baseDir: string;
    builtRoot: string;
    glissaHome: string | null;
    now: () => number;
  },
): Promise<BuildReport> {
  const spec = entry.spec;

  const files: ReadFile[] = [];
  try {
    for (const [index, source] of spec.sources.entries()) {
      files.push(...(await readFilesForSource(source, index, baseDir, { glissaHome })));
    }
    for (const [index, skill] of (spec.skills || []).entries()) {
      files.push(...(await readFilesForSkill(skill, index, baseDir, { glissaHome })));
    }
  } catch (err) {
    return failure(entry.name, specPath, [`could not read sources: ${errorMessage(err)}`]);
  }

  const built = planPackBuild(spec, files, {
    builtAt: new Date(now()).toISOString(),
    variant: entry.variant,
    sourceRoots: manifestSourceRoots(spec, { baseDir, glissaHome }),
  });
  if (!built.ok) return failure(entry.name, specPath, built.errors);
  if (!built.manifest) return failure(entry.name, specPath, ['pack build returned no manifest']);
  const manifest = built.manifest;

  const report = buildReport(entry.name, specPath, {
    ok: true,
    version: manifest.version,
    fileCount: built.outputs.length,
    tokenEstimate: manifest.tokenEstimate,
    budgetTokens: manifest.budgetTokens,
    currentDir: packVersionDirectory(path.join(builtRoot, entry.name), manifest.version),
  });

  const published = await readBuiltManifest(entry.name, { builtRoot });
  if (published && published.version === manifest.version) return { ...report, unchanged: true };

  try {
    await publishBuild(builtRoot, entry.name, built.outputs, { version: manifest.version });
  } catch (err) {
    return failure(entry.name, specPath, [`could not publish pack: ${errorMessage(err)}`]);
  }
  return report;
}

async function buildPack({
  specPath,
  baseDir = DEFAULT_PACKS_DIR,
  builtRoot = defaultBuiltRoot(),
  glissaHome = null,
  projects = [],
  now = Date.now,
}: {
  specPath?: string;
  baseDir?: string;
  builtRoot?: string;
  glissaHome?: string | null;
  projects?: Record<string, unknown>[];
  now?: () => number;
} = {}): Promise<BuildReport> {
  if (!specPath) return failure('', '', ['spec path required']);
  const fallbackName = path.basename(specPath).replace(/\.pack\.json$/, '');

  let spec: unknown;
  try {
    spec = await loadPackSpec(specPath);
  } catch (err) {
    return failure(fallbackName, specPath, [`could not read spec: ${errorMessage(err)}`]);
  }

  const specCheck = validatePackSpec(spec);
  if (!specCheck.ok) return failure(fallbackName, specPath, specCheck.errors);
  const validSpec = spec as PackSpec;
  if (validSpec.name !== fallbackName) {
    return failure(fallbackName, specPath, [`spec name "${validSpec.name}" does not match its filename`]);
  }

  const plan = planPackVariants(validSpec, projects);
  const reports: BuildReport[] = [];
  for (const entry of plan.builds) {
    reports.push(await buildOnePack(entry, { specPath, baseDir, builtRoot, glissaHome, now }));
  }
  const [base = failure(fallbackName, specPath, plan.warnings), ...variants] = reports;
  return { ...base, variants, warnings: plan.warnings };
}

async function buildPacks({
  name = null,
  specsDir = defaultSpecsDir(),
  baseDir = DEFAULT_PACKS_DIR,
  builtRoot = defaultBuiltRoot(),
  glissaHome = null,
  projects = [],
  now = Date.now,
}: {
  name?: string | null;
  specsDir?: string;
  baseDir?: string;
  builtRoot?: string;
  glissaHome?: string | null;
  projects?: Record<string, unknown>[];
  now?: () => number;
} = {}): Promise<BuildReport[]> {
  const specs = await listPackSpecs({ specsDir });
  const wanted = name ? specs.filter((spec) => spec.name === name) : specs;
  if (name && wanted.length === 0) {
    return [failure(name, path.join(specsDir, `${name}${SPEC_SUFFIX}`), [`no spec named "${name}" in ${specsDir}`])];
  }
  const reports: BuildReport[] = [];
  for (const spec of wanted) {
    try {
      const report = await buildPack({ specPath: spec.specPath, baseDir, builtRoot, glissaHome, projects, now });
      reports.push(report, ...report.variants);
    } catch (err) {
      reports.push(failure(spec.name, spec.specPath, [`build crashed: ${errorMessage(err)}`]));
    }
  }
  return reports;
}

async function describePackSpec(specPath: string): Promise<{
  valid: boolean;
  sourceCount: number;
  budgetTokens: number | null;
}> {
  try {
    const spec = (await loadPackSpec(specPath)) as PackSpec;
    return {
      valid: validatePackSpec(spec).ok,
      sourceCount: Array.isArray(spec.sources) ? spec.sources.length : 0,
      budgetTokens: typeof spec.budgetTokens === 'number' ? spec.budgetTokens : null,
    };
  } catch {
    return { valid: false, sourceCount: 0, budgetTokens: null };
  }
}

export {
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
export type { BuildReport, DistillSourceHash, ReadFile, ResolvedBuiltPack, SpecListing };
