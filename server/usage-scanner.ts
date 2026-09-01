import type { Dirent } from 'node:fs';
import nodeFsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { buildUsageReport, localDayKey, pruneEntries } from './core/usage-aggregate-core.ts';
import { dailyBaseline, detectBurnAnomaly, detectDailyAnomaly } from './core/usage-anomaly-core.ts';
import { buildBlocks, burnRate, projectBlock } from './core/usage-blocks-core.ts';
import type { UsageBlock } from './core/usage-blocks-core.ts';
import { budgetStanding, normalizeBudgetConfig } from './core/usage-budget-core.ts';
import { codexDedupIdentity, createCodexUsageState, parseCodexUsageLine } from './core/usage-codex-core.ts';
import type { CodexUsageState } from './core/usage-codex-core.ts';
import {
  dedupKeys,
  expandAdvisorIterations,
  identityFromRelPath,
  parseUsageLine,
  shouldReplace,
  totalTokensOf,
} from './core/usage-entry-core.ts';
import type { UsageEntry } from './core/usage-entry-core.ts';
import { grokDedupIdentity, parseGrokUsageLine } from './core/usage-grok-core.ts';
import { laneRollup } from './core/usage-lane-core.ts';
import { costForEntry, lookupModelPrice } from './core/usage-pricing-core.ts';
import type { ModelPrice } from './core/usage-pricing-core.ts';
import {
  codexFallbackRoots,
  codexHomes,
  codexRootCandidates,
  codexSessionIdFromPath,
  decideFileRead,
  dedupeCodexFiles,
  grokHomes,
  grokRootCandidates,
  isUsageFile,
  projectDirCandidates,
  resolveProjectsDirs,
  splitLines,
} from './core/usage-scan-core.ts';
import type { VendorRoot } from './core/usage-scan-core.ts';
import {
  mergeWarehouse,
  pruneWarehouse,
  rollupFromReport,
  warehouseDailyRows,
} from './core/usage-warehouse-core.ts';
import type { WarehouseRecord } from './core/usage-warehouse-core.ts';
import { createJsonStateWriter } from './json-file.ts';

const DEFAULT_BYTE_BUDGET = 64 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const LINE_YIELD_INTERVAL = 5000;
const SYNTHETIC_PRIMARY = Symbol('syntheticPrimary');
const ANOMALY_BASELINE_DAYS = 30;

const noopLogger = Object.freeze({ warn: () => {} });

type ScannerLogger = Pick<Console, 'warn'> | { warn: (message: string) => void };
interface ScannerFileStat {
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
}

interface ScannerFileHandle {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<unknown>;
}

type ScannerFileSystem =
  Pick<typeof nodeFsPromises, 'mkdir' | 'writeFile' | 'rename' | 'rm' | 'appendFile'>
  & {
    stat(filePath: string): Promise<ScannerFileStat>;
    readdir(dir: string, options: { withFileTypes: true }): Promise<Dirent[]>;
    readFile(filePath: string, encoding: 'utf8'): Promise<string>;
    open(filePath: string, flags: string): Promise<ScannerFileHandle>;
  };

type StoredEntry = UsageEntry & {
  inlineSessionId?: string | null;
  [SYNTHETIC_PRIMARY]?: string;
};

interface EntryKeys {
  primary: string | null;
  collision: string | null;
}

interface FileState {
  size: number;
  mtimeMs: number;
  offset: number;
  carry: string;
  lineOrdinal: number;
  vendorState: CodexUsageState | null;
}

type FileJournalAction =
  | { type: 'insert'; index: number; keys: EntryKeys }
  | { type: 'replace'; index: number; oldEntry: StoredEntry; oldKeys: EntryKeys; newKeys: EntryKeys };

interface ScanRoot {
  vendor: string;
  dir: string;
  kind: string;
}

interface SourceFile {
  file: string;
  vendor: string;
  kind: string;
}

interface SessionTotal {
  tokens: number;
  costUSD: number;
  lastTs: number | null;
}

interface UsageScannerOptions {
  fsPromises?: ScannerFileSystem;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  nowFn?: () => number;
  pricingTable?: Map<string, ModelPrice> | null;
  aliases?: Record<string, string>;
  costMode?: string;
  blockHours?: number;
  retainDays?: number;
  extraProjectsDirs?: string[];
  vendors?: { codex?: boolean; grok?: boolean };
  warehousePath?: string | null;
  warehouseRetainDays?: number;
  budget?: { dailyUsd?: unknown; monthlyUsd?: unknown } | null;
  laneMap?: (() => Map<string, string>) | null;
  logger?: ScannerLogger;
  byteBudget?: number;
  chunkSize?: number;
}

interface PassResult {
  files: number;
  entries: number;
  newEntries: number;
  partial: boolean;
  durationMs: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(logger: ScannerLogger | null | undefined, message: string): void {
  if (!logger || typeof logger.warn !== 'function') return;
  logger.warn(message);
}

function yieldNow(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createVendorState(vendor: string): CodexUsageState | null {
  if (vendor === 'codex') return createCodexUsageState();
  return null;
}

function cloneVendorState(vendorState: CodexUsageState | null): CodexUsageState | null {
  if (!vendorState) return vendorState;
  return { ...vendorState };
}

function deleteIndexKeys(
  keys: EntryKeys,
  primaryIndex: Map<string, number>,
  collisionIndex: Map<string, number>,
): void {
  if (keys.primary) primaryIndex.delete(keys.primary);
  if (keys.collision) collisionIndex.delete(keys.collision);
}

function stripIngestFields(entry: StoredEntry): StoredEntry {
  const { iterations, ...storedEntry } = entry;
  return storedEntry;
}

function shouldTrackMissingModel(
  { entry, resolved, priced, costMode }: {
    entry: StoredEntry;
    resolved: { price?: ModelPrice | null } | null;
    priced: { priced?: boolean };
    costMode: string;
  },
): boolean {
  if (entry?.vendor === 'grok') return false;
  if (costMode === 'display') return false;
  if (resolved) return false;
  if (priced.priced) return false;
  if (!entry.model) return false;
  return totalTokensOf(entry) > 0;
}

function isClaudeEntry(entry: { vendor?: unknown } | null | undefined): boolean {
  const vendor = typeof entry?.vendor === 'string' ? entry.vendor.trim() : '';
  return vendor === '' || vendor === 'claude';
}

function entriesWithinDays(
  sourceEntries: StoredEntry[],
  { now, retainDays }: { now: number; retainDays: number },
): StoredEntry[] {
  const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
  return sourceEntries.filter((entry) => entry.timestampMs >= cutoff);
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function cloneSessionTotals(source: Map<string, SessionTotal>): Map<string, SessionTotal> {
  const clone = new Map<string, SessionTotal>();
  for (const [key, value] of source) clone.set(key, { ...value });
  return clone;
}

function utf8SequenceLength(byte: number): number {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

function fullyDecodedUtf8PrefixLength(buffer: Buffer): number {
  let continuationBytes = 0;
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    const byte = buffer[index];
    if ((byte & 0xc0) === 0x80) {
      continuationBytes += 1;
      continue;
    }
    const expectedLength = utf8SequenceLength(byte);
    if (expectedLength === 1) return buffer.length;
    const actualLength = continuationBytes + 1;
    if (actualLength >= expectedLength) return buffer.length;
    return index;
  }
  return 0;
}

function relativeToProjects(file: string, dirs: string[]): string {
  const owner = dirs.find((dir) => file.startsWith(`${dir}${path.sep}`));
  if (!owner) return path.basename(file);
  return path.relative(owner, file);
}

function keysForEntry(entry: StoredEntry, syntheticPrimary: string | null = null): EntryKeys {
  if (entry?.vendor === 'codex') return { primary: codexDedupIdentity(entry), collision: null };
  if (entry?.vendor === 'grok') return { primary: grokDedupIdentity(entry), collision: null };
  const keys = dedupKeys(entry);
  return { primary: keys.primary || syntheticPrimary || entry?.[SYNTHETIC_PRIMARY] || null, collision: keys.collision };
}

async function resolveProjectsDirsAsync(
  { fsPromises, env, extraProjectsDirs, homeDir, logger }: {
    fsPromises: ScannerFileSystem;
    env: NodeJS.ProcessEnv;
    extraProjectsDirs: string[];
    homeDir: string;
    logger: ScannerLogger;
  },
): Promise<{ dirs: string[]; error: string | null }> {
  const candidates = projectDirCandidates(env, extraProjectsDirs, homeDir);
  const existing = new Set<string>();
  await Promise.all(candidates.map(async (candidate) => {
    try {
      const stat = await fsPromises.stat(candidate);
      if (stat.isDirectory()) existing.add(candidate);
    } catch {
      return null;
    }
    return null;
  }));
  try {
    return {
      dirs: resolveProjectsDirs(env, extraProjectsDirs, (candidate) => existing.has(candidate), homeDir),
      error: null,
    };
  } catch (error) {
    warn(logger, `usage scan project dir resolution failed: ${errorMessage(error)}`);
    return { dirs: [], error: errorMessage(error) };
  }
}

async function existingRoots(candidates: VendorRoot[], fsPromises: ScannerFileSystem): Promise<VendorRoot[]> {
  const checks = await Promise.all(candidates.map(async (candidate) => {
    try {
      const stat = await fsPromises.stat(candidate.dir);
      return stat.isDirectory() ? candidate : null;
    } catch {
      return null;
    }
  }));
  return checks.filter((candidate): candidate is VendorRoot => candidate !== null);
}

async function resolveVendorRootsAsync(
  { fsPromises, env, homeDir, vendors }: {
    fsPromises: ScannerFileSystem;
    env: NodeJS.ProcessEnv;
    homeDir: string;
    vendors: { codex?: boolean; grok?: boolean } | null | undefined;
  },
): Promise<ScanRoot[]> {
  const roots: ScanRoot[] = [];
  if (vendors?.codex !== false) {
    const homes = codexHomes(env, homeDir);
    const surviving = await existingRoots(codexRootCandidates(homes), fsPromises);
    const fallback = await existingRoots(codexFallbackRoots(homes, surviving), fsPromises);
    for (const root of [...surviving, ...fallback]) roots.push({ vendor: 'codex', dir: root.dir, kind: root.kind });
  }
  if (vendors?.grok !== false) {
    const surviving = await existingRoots(grokRootCandidates(grokHomes(env, homeDir)), fsPromises);
    for (const root of surviving) roots.push({ vendor: 'grok', dir: root.dir, kind: root.kind });
  }
  return roots;
}

async function walkDir(
  dir: string,
  vendor: string,
  fsPromises: ScannerFileSystem,
  files: string[],
  logger: ScannerLogger,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    warn(logger, `usage scan readdir failed for ${dir}: ${errorMessage(error)}`);
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, vendor, fsPromises, files, logger);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isUsageFile(vendor, entry.name)) continue;
    files.push(fullPath);
  }
}

async function walkSourceFiles(
  roots: ScanRoot[],
  fsPromises: ScannerFileSystem,
  logger: ScannerLogger,
): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const root of roots) {
    const found: string[] = [];
    await walkDir(root.dir, root.vendor, fsPromises, found, logger);
    for (const file of found) files.push({ file, vendor: root.vendor, kind: root.kind });
  }
  const codexFiles = dedupeCodexFiles(files.filter((entry) => entry.vendor === 'codex'));
  const others = files.filter((entry) => entry.vendor !== 'codex');
  return [...others, ...codexFiles].sort((left, right) => left.file.localeCompare(right.file));
}

function createUsageScanner(deps: UsageScannerOptions = {}) {
  const {
    fsPromises = nodeFsPromises,
    env = process.env,
    homeDir = os.homedir(),
    nowFn = Date.now,
    pricingTable,
    aliases = {},
    costMode = 'auto',
    blockHours = 5,
    retainDays = 90,
    extraProjectsDirs = [],
    vendors = { codex: true, grok: true },
    warehousePath = null,
    warehouseRetainDays = 365,
    budget: budgetDep = null,
    laneMap = null,
    logger = noopLogger,
    byteBudget = DEFAULT_BYTE_BUDGET,
    chunkSize = DEFAULT_CHUNK_SIZE,
  } = deps;

  const budget = normalizeBudgetConfig(budgetDep);
  const fileStates = new Map<string, FileState | null>();
  const primaryIndex = new Map<string, number>();
  const collisionIndex = new Map<string, number>();
  const entries: StoredEntry[] = [];
  const missingModels = new Set<string>();
  let claudeDirs: string[] = [];
  let dirs: string[] = [];
  let lastFileCount = 0;
  let lastScanMs: number | null = null;
  let lastPartial = false;
  let activePass: Promise<PassResult> | null = null;
  let pendingForce = false;
  let isReportDirty = true;
  let resolutionError: string | null = null;
  const cachedRollupsByDays = new Map<number | undefined, ReturnType<typeof buildRollups>>();
  let cachedSessionTotals: Map<string, SessionTotal> | null = null;
  let currentFileJournal: FileJournalAction[] | null = null;
  let warehouseRecords: WarehouseRecord[] = [];
  let warehouseLoaded = false;
  const warehouseWriter = warehousePath
    ? createJsonStateWriter({
      filePath: warehousePath,
      fsPromises,
      warn: (error: unknown) => warn(logger, `usage warehouse write failed: ${errorMessage(error)}`),
    })
    : null;

  function markDirty(): void {
    isReportDirty = true;
    cachedRollupsByDays.clear();
    cachedSessionTotals = null;
  }

  function recordJournal(action: FileJournalAction): void {
    if (!currentFileJournal) return;
    currentFileJournal.push(action);
  }

  function indexEntry(index: number, entry: StoredEntry, keys: EntryKeys = keysForEntry(entry)): void {
    if (keys.primary) primaryIndex.set(keys.primary, index);
    if (keys.collision) collisionIndex.set(keys.collision, index);
  }

  function reindexReplacement(index: number, oldKeys: EntryKeys, newKeys: EntryKeys, entry: StoredEntry): void {
    if (oldKeys.primary && oldKeys.primary !== newKeys.primary) primaryIndex.delete(oldKeys.primary);
    if (oldKeys.collision && oldKeys.collision !== newKeys.collision) collisionIndex.delete(oldKeys.collision);
    indexEntry(index, entry, newKeys);
  }

  function rebuildIndexes(): void {
    primaryIndex.clear();
    collisionIndex.clear();
    for (let index = 0; index < entries.length; index += 1) indexEntry(index, entries[index]);
  }

  function rebuildMissingModels(): void {
    missingModels.clear();
    for (const entry of entries) {
      const resolved = lookupModelPrice(pricingTable, entry.model, { aliases });
      const priced = costForEntry(entry, resolved?.price || null, { costMode });
      if (!shouldTrackMissingModel({ entry, resolved, priced, costMode })) continue;
      if (entry.model) missingModels.add(entry.model);
    }
  }

  function resetStore(): void {
    fileStates.clear();
    primaryIndex.clear();
    collisionIndex.clear();
    entries.length = 0;
    missingModels.clear();
    markDirty();
  }

  function rollbackCurrentFile(): void {
    if (!currentFileJournal) return;
    for (let index = currentFileJournal.length - 1; index >= 0; index -= 1) {
      const action = currentFileJournal[index];
      if (action.type === 'insert') {
        entries.length = action.index;
        deleteIndexKeys(action.keys, primaryIndex, collisionIndex);
        continue;
      }
      entries[action.index] = action.oldEntry;
      reindexReplacement(action.index, action.newKeys, action.oldKeys, action.oldEntry);
    }
    rebuildMissingModels();
    markDirty();
  }

  function priceEntry(entry: StoredEntry): StoredEntry {
    if (entry.vendor === 'grok') return entry;
    const resolved = lookupModelPrice(pricingTable, entry.model, { aliases });
    const priced = costForEntry(entry, resolved?.price || null, { costMode });
    if (shouldTrackMissingModel({ entry, resolved, priced, costMode }) && entry.model) missingModels.add(entry.model);
    return { ...entry, costUSD: priced.costUSD };
  }

  function storeEntry(entry: StoredEntry, syntheticPrimary: string | null = null): boolean {
    const keys = keysForEntry(entry, syntheticPrimary);
    const primaryHit = keys.primary === null ? undefined : primaryIndex.get(keys.primary);
    const collisionHit = keys.collision ? collisionIndex.get(keys.collision) : undefined;
    const hitIndex = primaryHit !== undefined ? primaryHit : collisionHit;
    const existing = hitIndex !== undefined ? entries[hitIndex] : null;
    const isCollisionDuplicate = existing && collisionHit !== undefined && (existing.isSidechain || entry.isSidechain);
    const isDuplicate = primaryHit !== undefined || isCollisionDuplicate;
    if (!isDuplicate) {
      const newIndex = entries.push(entry) - 1;
      recordJournal({ type: 'insert', index: newIndex, keys });
      indexEntry(newIndex, entry, keys);
      return true;
    }
    if (hitIndex === undefined) return false;
    if (!shouldReplace(existing, entry)) return false;
    const oldEntry = entries[hitIndex];
    const oldKeys = keysForEntry(oldEntry);
    recordJournal({ type: 'replace', index: hitIndex, oldEntry, oldKeys, newKeys: keys });
    entries[hitIndex] = entry;
    reindexReplacement(hitIndex, oldKeys, keys, entry);
    markDirty();
    return false;
  }

  function ingestVendorLine(parsed: UsageEntry | null, file: string): number {
    if (!parsed) return 0;
    const entry = stripIngestFields(priceEntry({ ...parsed, project: path.dirname(file) }));
    return storeEntry(entry) ? 1 : 0;
  }

  function ingestLine(
    { line, file, vendor, vendorState, dirs: claudeRoots, lineOrdinal }: {
      line: string;
      file: string;
      vendor: string;
      vendorState: CodexUsageState | null;
      dirs: string[];
      lineOrdinal: number;
    },
  ): number {
    if (vendor === 'codex') {
      const parsedCodexEntry = parseCodexUsageLine(line, vendorState ?? createCodexUsageState());
      if (!parsedCodexEntry) return 0;
      return ingestVendorLine({ ...parsedCodexEntry, sessionId: codexSessionIdFromPath(file) }, file);
    }
    if (vendor === 'grok') return ingestVendorLine(parseGrokUsageLine(line), file);
    const parsed = parseUsageLine(line);
    if (!parsed) return 0;
    const relPath = relativeToProjects(file, claudeRoots);
    const identity = identityFromRelPath(relPath);
    const inlineSessionId = parsed.sessionId;
    const rawEntries = [parsed, ...expandAdvisorIterations(parsed)];
    let accepted = 0;
    for (const rawEntry of rawEntries) {
      const syntheticPrimary = rawEntry.messageId ? null : `${relPath}:${lineOrdinal}`;
      const entry = priceEntry({
        ...rawEntry,
        sessionId: rawEntry.sessionId || identity.sessionId,
        project: identity.project,
        inlineSessionId,
      });
      const storedEntry = stripIngestFields(entry);
      if (syntheticPrimary) storedEntry[SYNTHETIC_PRIMARY] = syntheticPrimary;
      if (storeEntry(storedEntry, syntheticPrimary || null)) accepted += 1;
    }
    return accepted;
  }

  async function scanFile(
    { file, vendor, force, maxBytes, onLine, shouldYieldAfterLine }: {
      file: string;
      vendor: string;
      force: boolean;
      maxBytes: number;
      onLine: (line: string, lineOrdinal: number, vendorState: CodexUsageState | null) => void;
      shouldYieldAfterLine: () => boolean;
    },
  ): Promise<{ bytesRead: number; partial: boolean; failed?: boolean }> {
    let stat: ScannerFileStat;
    try {
      stat = await fsPromises.stat(file);
    } catch (error) {
      warn(logger, `usage scan stat failed for ${file}: ${errorMessage(error)}`);
      return { bytesRead: 0, partial: false };
    }

    const prior = force ? null : fileStates.get(file) ?? null;
    const hadPrior = fileStates.has(file);
    const decision = decideFileRead(prior, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (decision.action === 'skip') return { bytesRead: 0, partial: false };

    const state: FileState = decision.action === 'restart'
      ? { size: stat.size, mtimeMs: stat.mtimeMs, offset: 0, carry: '', lineOrdinal: 0, vendorState: createVendorState(vendor) }
      : { ...(prior || {}), size: stat.size, mtimeMs: stat.mtimeMs, offset: decision.readFrom, carry: prior?.carry || '', lineOrdinal: prior?.lineOrdinal || 0, vendorState: prior?.vendorState || createVendorState(vendor) };
    const priorSnapshot = prior ? { ...prior, vendorState: cloneVendorState(prior.vendorState) } : null;
    fileStates.set(file, state);

    let handle: ScannerFileHandle | undefined;
    let bytesRead = 0;
    let partial = false;
    const decoder = new StringDecoder('utf8');
    try {
      currentFileJournal = [];
      handle = await fsPromises.open(file, 'r');
      const buffer = Buffer.alloc(Math.max(1, chunkSize));
      let lastFullyDecodedOffset = state.offset;
      while (state.offset < stat.size) {
        if (bytesRead >= maxBytes) {
          partial = true;
          break;
        }
        const remainingFileBytes = stat.size - state.offset;
        const remainingBudgetBytes = maxBytes - bytesRead;
        const bytesToRead = Math.min(buffer.length, remainingFileBytes, remainingBudgetBytes);
        if (bytesToRead <= 0) {
          partial = true;
          break;
        }
        const readResult = await handle.read(buffer, 0, bytesToRead, state.offset);
        if (readResult.bytesRead <= 0) break;
        const readOffset = state.offset;
        const readBuffer = buffer.subarray(0, readResult.bytesRead);
        state.offset += readResult.bytesRead;
        bytesRead += readResult.bytesRead;
        lastFullyDecodedOffset = readOffset + fullyDecodedUtf8PrefixLength(readBuffer);
        const chunkText = decoder.write(readBuffer);
        const split = splitLines(state.carry, chunkText);
        state.carry = split.carry;
        for (const line of split.lines) {
          state.lineOrdinal = (state.lineOrdinal || 0) + 1;
          onLine(line, state.lineOrdinal, state.vendorState);
          if (shouldYieldAfterLine()) await yieldNow();
        }
      }
      if (partial) {
        state.offset = lastFullyDecodedOffset;
      }
      if (!partial) {
        const tail = decoder.end();
        const split = splitLines(state.carry, tail);
        state.carry = split.carry;
        for (const line of split.lines) {
          state.lineOrdinal = (state.lineOrdinal || 0) + 1;
          onLine(line, state.lineOrdinal, state.vendorState);
        }
      }
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
    } catch (error) {
      if (hadPrior) fileStates.set(file, priorSnapshot);
      if (!hadPrior) fileStates.delete(file);
      warn(logger, `usage scan read failed for ${file}: ${errorMessage(error)}`);
      return { bytesRead, partial: false, failed: true };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    return { bytesRead, partial, failed: false };
  }

  function pruneStoredEntries(): void {
    const pruned = pruneEntries(entries, { now: nowFn(), retainDays: entryRetentionDays() });
    if (pruned.kept.length === entries.length) return;
    entries.length = 0;
    entries.push(...(pruned.kept as StoredEntry[]));
    rebuildIndexes();
    rebuildMissingModels();
    markDirty();
  }


  function todayDayKey(): string {
    return localDayKey(nowFn());
  }

  async function loadWarehouse(): Promise<void> {
    if (warehouseLoaded || !warehousePath) return;
    if (!warehouseWriter) return;
    warehouseLoaded = true;
    let text: string | null = null;
    try {
      text = await fsPromises.readFile(warehousePath, 'utf8');
    } catch {
      return;
    }
    if (text === null) return;
    try {
      const parsed: unknown = JSON.parse(String(text));
      const rawRecords = parsed && typeof parsed === 'object' ? (parsed as { records?: unknown }).records : null;
      const records = Array.isArray(rawRecords) ? rawRecords : [];
      warehouseRecords = pruneWarehouse(records, { retainDays: warehouseRetainDays, todayKey: todayDayKey() });
      warehouseWriter.reset();
    } catch (error) {
      warn(logger, `usage warehouse unreadable, starting empty: ${errorMessage(error)}`);
      warehouseRecords = [];
    }
  }

  async function persistWarehouse(): Promise<void> {
    if (!warehouseWriter) return;
    await loadWarehouse();
    const rollups = cachedRollupsForDays(undefined, retainDays);
    const liveDays = rollups.daily.map((row) => row.day);
    const merged = mergeWarehouse(warehouseRecords, rollupFromReport(rollups.daily), { liveDays });
    warehouseRecords = pruneWarehouse(merged, { retainDays: warehouseRetainDays, todayKey: todayDayKey() });
    await warehouseWriter.write(
      warehouseRecords,
      () => `${JSON.stringify({ version: 1, updatedAt: new Date(nowFn()).toISOString(), records: warehouseRecords }, null, 2)}\n`,
    );
  }

  function daysElapsedThisMonth(): number {
    const day = Number(todayDayKey().slice(8, 10));
    return Number.isFinite(day) ? day : 1;
  }

  function entryRetentionDays(): number {
    if (budget.monthlyUsd === null) return retainDays;
    return Math.max(retainDays, daysElapsedThisMonth());
  }

  function buildRollups(reportRetainDays: number) {
    const report = {
      ...buildUsageReport(entries, {
        now: nowFn(),
        blockHours,
        retainDays: reportRetainDays,
      }),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    };
    return {
      tz: report.tz,
      blockHours: report.blockHours,
      totals: report.totals,
      daily: report.daily,
      models: report.models,
      sessions: report.sessions,
    };
  }

  function cachedRollupsForDays(days: number | undefined, reportRetainDays: number) {
    const cached = cachedRollupsByDays.get(days);
    if (cached && !isReportDirty) return cached;
    const rollups = buildRollups(reportRetainDays);
    cachedRollupsByDays.set(days, rollups);
    isReportDirty = false;
    return rollups;
  }

  function budgetRollups() {
    const lookback = entryRetentionDays();
    if (lookback === retainDays) return cachedRollupsForDays(undefined, retainDays);
    return cachedRollupsForDays(lookback, lookback);
  }

  function sortedModels<T extends { tokens: number }>(models: T[] | null | undefined): T[] {
    return (models || []).slice().sort((a, b) => b.tokens - a.tokens);
  }

  function mergedDailyRows<T extends { day: string; costUSD: number }>(liveDaily: T[]) {
    if (warehouseRecords.length === 0) return liveDaily;
    const liveDays = liveDaily.map((row) => row.day).filter(Boolean);
    const earliestLive = liveDays.length > 0 ? liveDays.slice().sort()[0] : null;
    const historyRows = warehouseDailyRows(warehouseRecords)
      .filter((row) => (earliestLive === undefined || earliestLive === null ? true : row.day < earliestLive))
      .map((row) => ({ ...row, models: sortedModels(row.models), vendors: [], source: 'history' }));
    if (historyRows.length === 0) return liveDaily;
    return [...historyRows, ...liveDaily].sort((a, b) => a.day.localeCompare(b.day));
  }

  function budgetSpend() {
    const todayKey = todayDayKey();
    const monthKey = todayKey.slice(0, 7);
    const daily = mergedDailyRows(budgetRollups().daily);
    let todayUsd = 0;
    let monthUsd = 0;
    for (const row of daily) {
      const cost = Number.isFinite(row.costUSD) ? row.costUSD : 0;
      if (row.day === todayKey) todayUsd += cost;
      if (String(row.day).startsWith(monthKey)) monthUsd += cost;
    }
    return { todayKey, monthKey, todayUsd, monthUsd };
  }

  function buildBudget() {
    if (budget.dailyUsd === null && budget.monthlyUsd === null) return null;
    const spend = budgetSpend();
    return {
      dailyUsd: budget.dailyUsd,
      monthlyUsd: budget.monthlyUsd,
      rows: budgetStanding({ budget, todayUsd: spend.todayUsd, monthUsd: spend.monthUsd }),
    };
  }

  function buildAnomaly(
    daily: { day: string; costUSD?: unknown; tokens?: unknown }[],
    blockSummary: { blocks: UsageBlock[] },
    activeBlock: (UsageBlock & { burn: ReturnType<typeof burnRate> }) | null,
  ) {
    const todayKey = todayDayKey();
    const ordered = daily.slice().sort((a, b) => a.day.localeCompare(b.day));
    const trailing = ordered.slice(-(ANOMALY_BASELINE_DAYS + 1));
    const baseline = dailyBaseline(trailing, { excludeDay: todayKey });
    const todayRow = ordered.find((row) => row.day === todayKey) || null;
    const daily30 = detectDailyAnomaly({
      todayUsd: todayRow?.costUSD,
      todayTokens: todayRow?.tokens,
      baseline,
    });
    const burn = detectBurnAnomaly({
      currentTokensPerMinute: activeBlock?.burn?.tokensPerMinute,
      completedBlocks: (blockSummary.blocks || []).filter((block) => !block.isGap && !block.isActive),
    });
    return {
      daily: daily30 && baseline ? { ...daily30, baselineDays: baseline.days } : null,
      burn,
    };
  }

  function buildLaneRows(reportRetainDays: number, now: number) {
    if (typeof laneMap !== 'function') return null;
    const lanes = laneMap();
    if (!(lanes instanceof Map) || lanes.size === 0) return null;
    return laneRollup(entriesWithinDays(entries, { now, retainDays: reportRetainDays }), lanes);
  }

  function buildReport({ days }: { days?: number } = {}) {
    const reportRetainDays = days == null ? retainDays : days;
    const rollups = cachedRollupsForDays(days, reportRetainDays);
    const now = nowFn();
    const blockEntries = entriesWithinDays(entries, { now, retainDays: reportRetainDays })
      .filter((entry) => isClaudeEntry(entry));
    const blockSummary = buildBlocks(blockEntries, { blockHours, now });
    const activeBurn = burnRate(blockSummary.activeBlock);
    const activeBlock = blockSummary.activeBlock
      ? { ...blockSummary.activeBlock, burn: activeBurn, projection: projectBlock(blockSummary.activeBlock, activeBurn, now) }
      : null;
    const daily = mergedDailyRows(cloneValue(rollups.daily));
    return {
      ts: now,
      tz: rollups.tz,
      blockHours: rollups.blockHours,
      totals: cloneValue(rollups.totals),
      daily,
      models: cloneValue(rollups.models),
      sessions: cloneValue(rollups.sessions),
      blocks: blockSummary.blocks,
      activeBlock,
      anomaly: buildAnomaly(daily, blockSummary, activeBlock),
      budget: buildBudget(),
      byLane: buildLaneRows(reportRetainDays, now),
      tokenLimit: blockSummary.tokenLimit,
      pricing: { missing: Array.from(missingModels).sort() },
      scan: { dirs: dirs.slice(), files: lastFileCount, entries: entries.length, lastScanMs, partial: lastPartial, resolutionError },
    };
  }

  function sessionTotals(): Map<string, SessionTotal> {
    if (cachedSessionTotals && !isReportDirty) return cloneSessionTotals(cachedSessionTotals);
    const totalsBySession = new Map<string, SessionTotal>();
    for (const entry of entries) {
      const key = isClaudeEntry(entry) ? entry.inlineSessionId : entry.sessionId;
      if (!key) continue;
      const bucket = totalsBySession.get(key) || { tokens: 0, costUSD: 0, lastTs: null };
      bucket.tokens += totalTokensOf(entry);
      bucket.costUSD += Number.isFinite(entry.costUSD) ? Number(entry.costUSD) : 0;
      bucket.lastTs = Math.max(bucket.lastTs || 0, entry.timestampMs);
      totalsBySession.set(key, bucket);
    }
    cachedSessionTotals = totalsBySession;
    return cloneSessionTotals(cachedSessionTotals);
  }

  function stats() {
    return { dirs: dirs.slice(), files: lastFileCount, entries: entries.length, lastScanMs, resolutionError };
  }

  async function runPassInternal({ force }: { force: boolean }): Promise<PassResult> {
    const startedAt = nowFn();
    let parsedLineCount = 0;
    let newEntryCount = 0;
    let partial = false;
    let bytesReadThisPass = 0;
    if (force) resetStore();
    const resolved = await resolveProjectsDirsAsync({ fsPromises, env, extraProjectsDirs, homeDir, logger });
    claudeDirs = resolved.dirs;
    resolutionError = resolved.error;
    const vendorRoots = await resolveVendorRootsAsync({ fsPromises, env, homeDir, vendors });
    const roots: ScanRoot[] = [
      ...claudeDirs.map((dir) => ({ vendor: 'claude', dir, kind: 'active' })),
      ...vendorRoots,
    ];
    dirs = roots.map((root) => root.dir);
    const files = await walkSourceFiles(roots, fsPromises, logger);
    lastFileCount = files.length;

    for (const file of files) {
      const remainingBudget = byteBudget - bytesReadThisPass;
      if (remainingBudget <= 0) {
        partial = true;
        break;
      }
      let fileNewEntryCount = 0;
      const fileResult = await scanFile({
        file: file.file,
        vendor: file.vendor,
        force,
        maxBytes: remainingBudget,
        onLine: (line, lineOrdinal, vendorState) => {
          parsedLineCount += 1;
          fileNewEntryCount += ingestLine({ line, file: file.file, vendor: file.vendor, vendorState, dirs: claudeDirs, lineOrdinal });
        },
        shouldYieldAfterLine: () => parsedLineCount % LINE_YIELD_INTERVAL === 0,
      });
      if (fileResult.failed) rollbackCurrentFile();
      if (!fileResult.failed) newEntryCount += fileNewEntryCount;
      currentFileJournal = null;
      bytesReadThisPass += fileResult.bytesRead;
      partial = partial || fileResult.partial;
      await yieldNow();
      if (partial) break;
    }

    pruneStoredEntries();
    lastScanMs = nowFn();
    lastPartial = partial;
    if (newEntryCount > 0) markDirty();
    if (!partial) await persistWarehouse();
    return {
      files: lastFileCount,
      entries: entries.length,
      newEntries: newEntryCount,
      partial,
      durationMs: nowFn() - startedAt,
    };
  }

  async function runPassChain({ force }: { force: boolean }): Promise<PassResult> {
    try {
      let result = await runPassInternal({ force });
      while (pendingForce) {
        pendingForce = false;
        result = await runPassInternal({ force: true });
      }
      return result;
    } finally {
      activePass = null;
    }
  }

  function runPass({ force = false }: { force?: boolean } = {}): Promise<PassResult> {
    if (activePass) {
      if (!force) return activePass;
      pendingForce = true;
      return activePass;
    }
    activePass = runPassChain({ force });
    return activePass;
  }

  const api = {
    runPass,
    buildReport,
    sessionTotals,
    stats,
    budgetSpend,
    _entriesForTest: () => entries.map((entry) => entry),
  };
  Object.defineProperty(api, '_entriesForTest', { enumerable: false });
  return api;
}

type UsageScannerApi = Omit<ReturnType<typeof createUsageScanner>, '_entriesForTest'>;

export { createUsageScanner };
export type { UsageScannerApi, UsageScannerOptions };
