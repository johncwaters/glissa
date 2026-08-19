'use strict';

const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const {
  dedupKeys,
  expandAdvisorIterations,
  identityFromRelPath,
  parseUsageLine,
  shouldReplace,
  totalTokensOf,
} = require('./core/usage-entry-core');
const { buildUsageReport, pruneEntries } = require('./core/usage-aggregate-core');
const { buildBlocks, burnRate, projectBlock } = require('./core/usage-blocks-core');
const { costForEntry, lookupModelPrice } = require('./core/usage-pricing-core');
const { decideFileRead, projectDirCandidates, resolveProjectsDirs, splitLines } = require('./core/usage-scan-core');

const DEFAULT_BYTE_BUDGET = 64 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const LINE_YIELD_INTERVAL = 5000;
const SYNTHETIC_PRIMARY = Symbol('syntheticPrimary');

const noopLogger = Object.freeze({ warn: () => {} });

function createUsageScanner(deps = {}) {
  const {
    fsPromises = require('node:fs/promises'),
    env = process.env,
    nowFn = Date.now,
    pricingTable,
    aliases = {},
    costMode = 'auto',
    blockHours = 5,
    retainDays = 90,
    extraProjectsDirs = [],
    logger = noopLogger,
    byteBudget = DEFAULT_BYTE_BUDGET,
    chunkSize = DEFAULT_CHUNK_SIZE,
  } = deps;

  const fileStates = new Map();
  const primaryIndex = new Map();
  const collisionIndex = new Map();
  const entries = [];
  const missingModels = new Set();
  let dirs = [];
  let lastFileCount = 0;
  let lastScanMs = null;
  let lastPartial = false;
  let activePass = null;
  let pendingForce = false;
  let isReportDirty = true;
  let resolutionError = null;
  const cachedRollupsByDays = new Map();
  let cachedSessionTotals = null;
  let currentFileJournal = null;

  function runPass({ force = false } = {}) {
    if (activePass) {
      if (!force) return activePass;
      pendingForce = true;
      return activePass;
    }
    activePass = runPassChain({ force });
    return activePass;
  }

  async function runPassChain({ force }) {
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

  async function runPassInternal({ force }) {
    const startedAt = nowFn();
    let parsedLineCount = 0;
    let newEntryCount = 0;
    let partial = false;
    let bytesReadThisPass = 0;
    if (force) resetStore();
    const resolved = await resolveProjectsDirsAsync({ fsPromises, env, extraProjectsDirs, logger });
    dirs = resolved.dirs;
    resolutionError = resolved.error;
    const files = await walkJsonlFiles(dirs, fsPromises, logger);
    lastFileCount = files.length;

    for (const file of files) {
      const remainingBudget = byteBudget - bytesReadThisPass;
      if (remainingBudget <= 0) {
        partial = true;
        break;
      }
      let fileNewEntryCount = 0;
      const fileResult = await scanFile({
        file,
        fsPromises,
        force,
        maxBytes: remainingBudget,
        chunkSize,
        onLine: (line, lineOrdinal) => {
          parsedLineCount += 1;
          fileNewEntryCount += ingestLine({ line, file, dirs, lineOrdinal });
        },
        shouldYieldAfterLine: () => parsedLineCount % LINE_YIELD_INTERVAL === 0,
        logger,
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
    return {
      files: lastFileCount,
      entries: entries.length,
      newEntries: newEntryCount,
      partial,
      durationMs: nowFn() - startedAt,
    };
  }

  async function scanFile({ file, fsPromises, force, maxBytes, chunkSize, onLine, shouldYieldAfterLine, logger }) {
    let stat;
    try {
      stat = await fsPromises.stat(file);
    } catch (error) {
      warn(logger, `usage scan stat failed for ${file}: ${error.message}`);
      return { bytesRead: 0, partial: false };
    }

    const prior = force ? null : fileStates.get(file);
    const hadPrior = fileStates.has(file);
    const decision = decideFileRead(prior, { size: stat.size, mtimeMs: stat.mtimeMs });
    if (decision.action === 'skip') return { bytesRead: 0, partial: false };

    const state = decision.action === 'restart'
      ? { size: stat.size, mtimeMs: stat.mtimeMs, offset: 0, carry: '', lineOrdinal: 0 }
      : { ...(prior || {}), size: stat.size, mtimeMs: stat.mtimeMs, offset: decision.readFrom, carry: prior?.carry || '' };
    fileStates.set(file, state);

    let handle;
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
          onLine(line, state.lineOrdinal);
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
          onLine(line, state.lineOrdinal);
        }
      }
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
    } catch (error) {
      if (hadPrior) fileStates.set(file, prior);
      if (!hadPrior) fileStates.delete(file);
      warn(logger, `usage scan read failed for ${file}: ${error.message}`);
      return { bytesRead, partial: false, failed: true };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    return { bytesRead, partial, failed: false };
  }

  function ingestLine({ line, file, dirs, lineOrdinal }) {
    const parsed = parseUsageLine(line);
    if (!parsed) return 0;
    const relPath = relativeToProjects(file, dirs);
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
      if (storeEntry(storedEntry, syntheticPrimary)) accepted += 1;
    }
    return accepted;
  }

  function priceEntry(entry) {
    const resolved = lookupModelPrice(pricingTable, entry.model, { aliases });
    const priced = costForEntry(entry, resolved?.price || null, { costMode });
    if (shouldTrackMissingModel({ entry, resolved, priced, costMode })) missingModels.add(entry.model);
    return { ...entry, costUSD: priced.costUSD };
  }

  function storeEntry(entry, syntheticPrimary = null) {
    const keys = keysForEntry(entry, syntheticPrimary);
    const primaryHit = primaryIndex.get(keys.primary);
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
    if (!shouldReplace(existing, entry)) return false;
    const oldEntry = entries[hitIndex];
    const oldKeys = keysForEntry(oldEntry);
    recordJournal({ type: 'replace', index: hitIndex, oldEntry, oldKeys, newKeys: keys });
    entries[hitIndex] = entry;
    reindexReplacement(hitIndex, oldKeys, keys, entry);
    markDirty();
    return false;
  }

  function pruneStoredEntries() {
    const pruned = pruneEntries(entries, { now: nowFn(), retainDays });
    if (pruned.kept.length === entries.length) return;
    entries.length = 0;
    entries.push(...pruned.kept);
    rebuildIndexes();
    rebuildMissingModels();
    markDirty();
  }

  function buildReport({ days } = {}) {
    const reportRetainDays = days == null ? retainDays : days;
    const rollups = cachedRollupsForDays(days, reportRetainDays);
    const now = nowFn();
    const blockEntries = entriesWithinDays(entries, { now, retainDays: reportRetainDays });
    const blockSummary = buildBlocks(blockEntries, { blockHours, now });
    const activeBurn = burnRate(blockSummary.activeBlock, now);
    const activeBlock = blockSummary.activeBlock
      ? { ...blockSummary.activeBlock, burn: activeBurn, projection: projectBlock(blockSummary.activeBlock, activeBurn, now) }
      : null;
    return {
      ts: now,
      tz: rollups.tz,
      blockHours: rollups.blockHours,
      totals: cloneValue(rollups.totals),
      daily: cloneValue(rollups.daily),
      models: cloneValue(rollups.models),
      sessions: cloneValue(rollups.sessions),
      blocks: blockSummary.blocks,
      activeBlock,
      tokenLimit: blockSummary.tokenLimit,
      pricing: { missing: Array.from(missingModels).sort() },
      scan: { dirs: dirs.slice(), files: lastFileCount, entries: entries.length, lastScanMs, partial: lastPartial, resolutionError },
    };
  }

  function sessionTotals() {
    if (cachedSessionTotals && !isReportDirty) return cloneSessionTotals(cachedSessionTotals);
    const totalsBySession = new Map();
    for (const entry of entries) {
      if (!entry.inlineSessionId) continue;
      const bucket = totalsBySession.get(entry.inlineSessionId) || { tokens: 0, costUSD: 0, lastTs: null };
      bucket.tokens += totalTokensOf(entry);
      bucket.costUSD += Number.isFinite(entry.costUSD) ? entry.costUSD : 0;
      bucket.lastTs = Math.max(bucket.lastTs || 0, entry.timestampMs);
      totalsBySession.set(entry.inlineSessionId, bucket);
    }
    cachedSessionTotals = totalsBySession;
    return cloneSessionTotals(cachedSessionTotals);
  }

  function stats() {
    return { dirs: dirs.slice(), files: lastFileCount, entries: entries.length, lastScanMs, resolutionError };
  }

  function indexEntry(index, entry, keys = keysForEntry(entry)) {
    if (keys.primary) primaryIndex.set(keys.primary, index);
    if (keys.collision) collisionIndex.set(keys.collision, index);
  }

  function reindexReplacement(index, oldKeys, newKeys, entry) {
    if (oldKeys.primary && oldKeys.primary !== newKeys.primary) primaryIndex.delete(oldKeys.primary);
    if (oldKeys.collision && oldKeys.collision !== newKeys.collision) collisionIndex.delete(oldKeys.collision);
    indexEntry(index, entry, newKeys);
  }

  function rebuildIndexes() {
    primaryIndex.clear();
    collisionIndex.clear();
    for (let index = 0; index < entries.length; index += 1) indexEntry(index, entries[index]);
  }

  function rebuildMissingModels() {
    missingModels.clear();
    for (const entry of entries) {
      const resolved = lookupModelPrice(pricingTable, entry.model, { aliases });
      const priced = costForEntry(entry, resolved?.price || null, { costMode });
      if (!shouldTrackMissingModel({ entry, resolved, priced, costMode })) continue;
      missingModels.add(entry.model);
    }
  }

  function cachedRollupsForDays(days, reportRetainDays) {
    const cached = cachedRollupsByDays.get(days);
    if (cached && !isReportDirty) return cached;
    const report = buildUsageReport(entries, {
      now: nowFn(),
      blockHours,
      retainDays: reportRetainDays,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    });
    const rollups = {
      tz: report.tz,
      blockHours: report.blockHours,
      totals: report.totals,
      daily: report.daily,
      models: report.models,
      sessions: report.sessions,
    };
    cachedRollupsByDays.set(days, rollups);
    isReportDirty = false;
    return rollups;
  }

  function resetStore() {
    fileStates.clear();
    primaryIndex.clear();
    collisionIndex.clear();
    entries.length = 0;
    missingModels.clear();
    markDirty();
  }

  function rollbackCurrentFile() {
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

  function recordJournal(action) {
    if (!currentFileJournal) return;
    currentFileJournal.push(action);
  }

  function markDirty() {
    isReportDirty = true;
    cachedRollupsByDays.clear();
    cachedSessionTotals = null;
  }

  const api = { runPass, buildReport, sessionTotals, stats };
  Object.defineProperty(api, '_entriesForTest', {
    value: () => entries.map((entry) => entry),
    enumerable: false,
  });
  return api;
}

async function resolveProjectsDirsAsync({ fsPromises, env, extraProjectsDirs, logger }) {
  const candidates = projectDirCandidates(env, extraProjectsDirs);
  const existing = new Set();
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
    return { dirs: resolveProjectsDirs(env, extraProjectsDirs, (candidate) => existing.has(candidate)), error: null };
  } catch (error) {
    warn(logger, `usage scan project dir resolution failed: ${error.message}`);
    return { dirs: [], error: error.message };
  }
}

async function walkJsonlFiles(dirs, fsPromises, logger) {
  const files = [];
  for (const dir of dirs) await walkDir(dir, fsPromises, files, logger);
  return files.sort();
}

async function walkDir(dir, fsPromises, files, logger) {
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    warn(logger, `usage scan readdir failed for ${dir}: ${error.message}`);
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, fsPromises, files, logger);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    files.push(fullPath);
  }
}

function relativeToProjects(file, dirs) {
  const owner = dirs.find((dir) => file.startsWith(`${dir}${path.sep}`));
  if (!owner) return path.basename(file);
  return path.relative(owner, file);
}

function keysForEntry(entry, syntheticPrimary = null) {
  const keys = dedupKeys(entry);
  return { primary: keys.primary || syntheticPrimary || entry?.[SYNTHETIC_PRIMARY] || null, collision: keys.collision };
}

function deleteIndexKeys(keys, primaryIndex, collisionIndex) {
  if (keys.primary) primaryIndex.delete(keys.primary);
  if (keys.collision) collisionIndex.delete(keys.collision);
}

function stripIngestFields(entry) {
  const { iterations, ...storedEntry } = entry;
  return storedEntry;
}

function shouldTrackMissingModel({ entry, resolved, priced, costMode }) {
  if (costMode === 'display') return false;
  if (resolved) return false;
  if (priced.priced) return false;
  if (!entry.model) return false;
  return totalTokensOf(entry) > 0;
}

function entriesWithinDays(sourceEntries, { now, retainDays }) {
  const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
  return sourceEntries.filter((entry) => entry.timestampMs >= cutoff);
}

function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function cloneSessionTotals(source) {
  const clone = new Map();
  for (const [key, value] of source) clone.set(key, { ...value });
  return clone;
}

function fullyDecodedUtf8PrefixLength(buffer) {
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

function utf8SequenceLength(byte) {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

function warn(logger, message) {
  if (!logger || typeof logger.warn !== 'function') return;
  logger.warn(message);
}

function yieldNow() {
  return new Promise((resolve) => setImmediate(resolve));
}

module.exports = { createUsageScanner };
