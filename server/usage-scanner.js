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
const { buildUsageReport, localDayKey, pruneEntries } = require('./core/usage-aggregate-core');
const { buildBlocks, burnRate, projectBlock } = require('./core/usage-blocks-core');
const { dailyBaseline, detectBurnAnomaly, detectDailyAnomaly } = require('./core/usage-anomaly-core');
const { budgetStanding, normalizeBudgetConfig } = require('./core/usage-budget-core');
const { laneRollup } = require('./core/usage-lane-core');
const {
  mergeWarehouse,
  pruneWarehouse,
  rollupFromReport,
  warehouseDailyRows,
} = require('./core/usage-warehouse-core');
const { costForEntry, lookupModelPrice } = require('./core/usage-pricing-core');
const {
  codexFallbackRoots,
  codexHomes,
  codexRootCandidates,
  codexSessionIdFromPath,
  dedupeCodexFiles,
  decideFileRead,
  grokHomes,
  grokRootCandidates,
  isUsageFile,
  projectDirCandidates,
  resolveProjectsDirs,
  splitLines,
} = require('./core/usage-scan-core');
const { codexDedupIdentity, createCodexUsageState, parseCodexUsageLine } = require('./core/usage-codex-core');
const { grokDedupIdentity, parseGrokUsageLine } = require('./core/usage-grok-core');

const DEFAULT_BYTE_BUDGET = 64 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const LINE_YIELD_INTERVAL = 5000;
const SYNTHETIC_PRIMARY = Symbol('syntheticPrimary');
// The anomaly baseline is the trailing month, NOT the whole retained series: a sparse multi-month mean
// makes an ordinary day look like a spike (and a heavy month makes a real spike look ordinary).
const ANOMALY_BASELINE_DAYS = 30;

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
    // Which non-Claude vendors to walk. A disabled vendor contributes no roots at all, so its tree is
    // never read and an all-Claude machine behaves exactly as before.
    vendors = { codex: true, grok: true },
    // Durable per-day-per-model history. Claude Code deletes transcripts after about 30 days, so without
    // this the daily series silently truncates and every longer view is quietly wrong. Absent path (older
    // callers, unit tests) means the warehouse is inert: nothing is read, nothing is written.
    warehousePath = null,
    warehouseRetainDays = 365,
    // Spend budgets (config usage.budget). Absent means off, and every budget surface then reports
    // nothing at all rather than a zero ceiling.
    budget: budgetDep = null,
    // Claude session id -> the Glissa lane that spawned it. A function rather than a snapshot so a report
    // always joins against what the ledger knows NOW, not what it knew when the scanner was built.
    laneMap = null,
    logger = noopLogger,
    byteBudget = DEFAULT_BYTE_BUDGET,
    chunkSize = DEFAULT_CHUNK_SIZE,
  } = deps;

  // Normalized once at this module's seam; nothing downstream re-normalizes.
  const budget = normalizeBudgetConfig(budgetDep);
  const fileStates = new Map();
  const primaryIndex = new Map();
  const collisionIndex = new Map();
  const entries = [];
  const missingModels = new Set();
  // `claudeDirs` drives Claude identity (relPath -> project + session id) and the resolution error;
  // `dirs` is every transcript root scanned, which is what the report reports.
  let claudeDirs = [];
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
  let warehouseRecords = [];
  let warehouseLoaded = false;
  let warehouseSignature = null;
  let warehouseWriteChain = Promise.resolve();

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
    claudeDirs = resolved.dirs;
    resolutionError = resolved.error;
    const vendorRoots = await resolveVendorRootsAsync({ fsPromises, env, vendors });
    const roots = [
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
        fsPromises,
        force,
        maxBytes: remainingBudget,
        chunkSize,
        onLine: (line, lineOrdinal, vendorState) => {
          parsedLineCount += 1;
          fileNewEntryCount += ingestLine({ line, file: file.file, vendor: file.vendor, vendorState, dirs: claudeDirs, lineOrdinal });
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
    /*
     * Only a COMPLETE pass may write history. A partial pass has seen an arbitrary slice of the tree, so
     * merging its day totals would persist an undercount as durable truth; that is also why continuation
     * storms cost no writes at all rather than needing a timer to coalesce them.
     */
    if (!partial) await persistWarehouse();
    return {
      files: lastFileCount,
      entries: entries.length,
      newEntries: newEntryCount,
      partial,
      durationMs: nowFn() - startedAt,
    };
  }

  async function scanFile({ file, vendor, fsPromises, force, maxBytes, chunkSize, onLine, shouldYieldAfterLine, logger }) {
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

    /*
     * Codex token_count lines report CUMULATIVE totals and name their model in a separate earlier line,
     * so an appended read has to continue from the same running snapshot or it would re-count the whole
     * session as one delta. That is what vendorState carries, per file, beside offset and carry.
     */
    const state = decision.action === 'restart'
      ? { size: stat.size, mtimeMs: stat.mtimeMs, offset: 0, carry: '', lineOrdinal: 0, vendorState: createVendorState(vendor) }
      : { ...(prior || {}), size: stat.size, mtimeMs: stat.mtimeMs, offset: decision.readFrom, carry: prior?.carry || '', vendorState: prior?.vendorState || createVendorState(vendor) };
    // The parsers MUTATE vendorState, so the rollback snapshot needs its own copy or a failed read would
    // leave the running Codex totals advanced past the entries that were just rolled back.
    const priorSnapshot = prior ? { ...prior, vendorState: cloneVendorState(prior.vendorState) } : null;
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
      warn(logger, `usage scan read failed for ${file}: ${error.message}`);
      return { bytesRead, partial: false, failed: true };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    return { bytesRead, partial, failed: false };
  }

  function ingestLine({ line, file, vendor, vendorState, dirs, lineOrdinal }) {
    if (vendor === 'codex') return ingestVendorLine(parseCodexUsageLine(line, vendorState, { sessionId: codexSessionIdFromPath(file) }), file);
    if (vendor === 'grok') return ingestVendorLine(parseGrokUsageLine(line), file);
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

  /*
   * A non-Claude entry, already in the shared entry shape. Its own core owns identity and (for Grok)
   * cost, and there is no advisor expansion or transcript-path identity to derive: the project is the
   * vendor's session dir, and attribution to a Glissa card is deliberately not attempted (cards are keyed
   * by CLAUDE session id).
   */
  function ingestVendorLine(parsed, file) {
    if (!parsed) return 0;
    const entry = stripIngestFields(priceEntry({ ...parsed, project: path.dirname(file) }));
    return storeEntry(entry) ? 1 : 0;
  }

  function priceEntry(entry) {
    // Grok reports its own cost in the transcript (billing ticks, or the parser's published rate card),
    // so it is authoritative here and never routed through the price table or the missing-price warning.
    if (entry.vendor === 'grok') return entry;
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
    const pruned = pruneEntries(entries, { now: nowFn(), retainDays: entryRetentionDays() });
    if (pruned.kept.length === entries.length) return;
    entries.length = 0;
    entries.push(...pruned.kept);
    rebuildIndexes();
    rebuildMissingModels();
    markDirty();
  }

  // ── Warehouse ──

  async function loadWarehouse() {
    if (warehouseLoaded || !warehousePath) return;
    warehouseLoaded = true;
    let text = null;
    try {
      text = await fsPromises.readFile(warehousePath, 'utf8');
    } catch {
      // No file yet is the ordinary first-run case, not a problem to report.
      return;
    }
    try {
      const parsed = JSON.parse(text);
      const records = Array.isArray(parsed?.records) ? parsed.records : [];
      warehouseRecords = pruneWarehouse(records, { retainDays: warehouseRetainDays, todayKey: todayDayKey() });
      warehouseSignature = null;
    } catch (error) {
      // A corrupt file starts empty rather than crashing the lane: the transcripts are still the source of
      // truth for everything inside live coverage, and the next complete pass rebuilds what it can see.
      warn(logger, `usage warehouse unreadable, starting empty: ${error.message}`);
      warehouseRecords = [];
    }
  }

  /*
   * Merge this pass's live day rollups into durable history and write atomically. `liveDays` is what the
   * scan actually produced, so a day the live scan covers always WINS over the stored copy (the live read
   * is fresher), while a day the transcripts no longer have survives untouched.
   */
  async function persistWarehouse() {
    if (!warehousePath) return;
    await loadWarehouse();
    const rollups = cachedRollupsForDays(undefined, retainDays);
    const liveDays = rollups.daily.map((row) => row.day);
    const merged = mergeWarehouse(warehouseRecords, rollupFromReport(rollups.daily), { liveDays });
    warehouseRecords = pruneWarehouse(merged, { retainDays: warehouseRetainDays, todayKey: todayDayKey() });
    const payload = `${JSON.stringify({ version: 1, updatedAt: new Date(nowFn()).toISOString(), records: warehouseRecords }, null, 2)}\n`;
    const signature = JSON.stringify(warehouseRecords);
    // Nothing moved: an idle machine rescanning on its interval should not rewrite the same bytes.
    if (signature === warehouseSignature) return;
    warehouseSignature = signature;
    // Not redundant: writeWarehouseFile's own catch can throw (bad logger), which must not fail the pass.
    warehouseWriteChain = warehouseWriteChain.then(() => writeWarehouseFile(payload)).catch(() => {});
    await warehouseWriteChain;
  }

  // tmp + rename, so a crash mid-write can never leave a half-written history file behind.
  async function writeWarehouseFile(payload) {
    const tmpPath = `${warehousePath}.tmp`;
    try {
      await fsPromises.mkdir(path.dirname(warehousePath), { recursive: true });
      await fsPromises.writeFile(tmpPath, payload);
      await fsPromises.rename(tmpPath, warehousePath);
    } catch (error) {
      warn(logger, `usage warehouse write failed: ${error.message}`);
      warehouseSignature = null;
    }
  }

  function todayDayKey() {
    return localDayKey(nowFn());
  }

  /*
   * Spend for the two budget periods, over the MERGED daily series so it matches what the panel shows
   * (history included). One definition, used both for the report's standing meters and for the wiring's
   * once-per-period alert evaluation, so a meter and an alert can never disagree about what was spent.
   */
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

  /*
   * The daily series the report ships: live rows, plus history for days OLDER than live coverage. Strictly
   * older, so a day the live scan is still filling in is never topped up from a stale stored copy. Each
   * history row is marked, because a row Glissa remembers is a different claim from one it can still see.
   */
  function mergedDailyRows(liveDaily) {
    if (warehouseRecords.length === 0) return liveDaily;
    const liveDays = liveDaily.map((row) => row.day).filter(Boolean);
    const earliestLive = liveDays.length > 0 ? liveDays.slice().sort()[0] : null;
    const historyRows = warehouseDailyRows(warehouseRecords)
      .filter((row) => (earliestLive === null ? true : row.day < earliestLive))
      .map((row) => ({ ...row, models: sortedModels(row.models), vendors: [], source: 'history' }));
    if (historyRows.length === 0) return liveDaily;
    return [...historyRows, ...liveDaily].sort((a, b) => a.day.localeCompare(b.day));
  }

  function sortedModels(models) {
    return (models || []).slice().sort((a, b) => b.tokens - a.tokens);
  }

  // ── Anomaly ──
  // Machine level only. A per-session baseline is a different data model (sessions are short and unevenly
  // sampled), so it is deliberately out of scope here.
  function buildAnomaly(daily, blockSummary, activeBlock) {
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
      daily: daily30 ? { ...daily30, baselineDays: baseline.days } : null,
      burn,
    };
  }

  function daysElapsedThisMonth() {
    const day = Number(todayDayKey().slice(8, 10));
    return Number.isFinite(day) ? day : 1;
  }

  // A monthly budget is measured against the whole month, so with one configured the entry store keeps
  // at least the elapsed month (pruning runs before aggregation, so widening later cannot recover days).
  function entryRetentionDays() {
    if (budget.monthlyUsd === null) return retainDays;
    return Math.max(retainDays, daysElapsedThisMonth());
  }

  // Matches the retention floor; a widened window needs its own cache key (memoized on the first arg).
  function budgetRollups() {
    const lookback = entryRetentionDays();
    if (lookback === retainDays) return cachedRollupsForDays(undefined, retainDays);
    return cachedRollupsForDays(lookback, lookback);
  }

  /*
   * The standing meters. Computed here rather than client-side because usage-budget-core owns the tone
   * ladder, and a second implementation in the browser core would be a second place for it to drift.
   */
  function buildBudget() {
    if (budget.dailyUsd === null && budget.monthlyUsd === null) return null;
    const spend = budgetSpend();
    return {
      dailyUsd: budget.dailyUsd,
      monthlyUsd: budget.monthlyUsd,
      rows: budgetStanding({ budget, todayUsd: spend.todayUsd, monthUsd: spend.monthUsd }),
    };
  }

  /*
   * Lane attribution over the LIVE window only. The ledger is durable, but the ENTRIES it joins against are
   * not: the warehouse stores day-by-model rollups with no session id in them, so a history day cannot be
   * split by lane. Fabricating history rows here would invent attribution that was never observed.
   */
  function buildLaneRows(reportRetainDays, now) {
    if (typeof laneMap !== 'function') return null;
    const lanes = laneMap();
    if (!(lanes instanceof Map) || lanes.size === 0) return null;
    return laneRollup(entriesWithinDays(entries, { now, retainDays: reportRetainDays }), lanes);
  }

  function buildReport({ days } = {}) {
    const reportRetainDays = days == null ? retainDays : days;
    const rollups = cachedRollupsForDays(days, reportRetainDays);
    const now = nowFn();
    /*
     * Blocks, burn rate and the token-limit reference are CLAUDE-ONLY. The 5h window is a Claude
     * subscription concept, and mixing another vendor's tokens into it would produce a number that looks
     * like a plan limit and is not one.
     */
    const blockEntries = entriesWithinDays(entries, { now, retainDays: reportRetainDays })
      .filter((entry) => isClaudeEntry(entry));
    const blockSummary = buildBlocks(blockEntries, { blockHours, now });
    const activeBurn = burnRate(blockSummary.activeBlock, now);
    const activeBlock = blockSummary.activeBlock
      ? { ...blockSummary.activeBlock, burn: activeBurn, projection: projectBlock(blockSummary.activeBlock, activeBurn, now) }
      : null;
    // Only the DAILY series is extended with history (and what the dashboard derives from it: the week and
    // month views, the heatmap, the anomaly baseline). Totals, models, sessions and blocks stay live-only,
    // because the warehouse stores day-by-model rollups and nothing finer.
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

  function sessionTotals() {
    if (cachedSessionTotals && !isReportDirty) return cloneSessionTotals(cachedSessionTotals);
    const totalsBySession = new Map();
    for (const entry of entries) {
      // Per-card attribution is by CLAUDE session id, so other vendors never reach a card chip.
      if (!isClaudeEntry(entry)) continue;
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

  const api = { runPass, buildReport, sessionTotals, stats, budgetSpend };
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

/*
 * Codex and Grok roots that actually exist. A missing home is silently absent, NOT an error: unlike
 * CLAUDE_CONFIG_DIR (an explicit claim that a directory is there), these are opportunistic. A vendor
 * switched off in config contributes no candidates at all, so its tree is never even stat'ed.
 */
async function resolveVendorRootsAsync({ fsPromises, env, vendors }) {
  const roots = [];
  if (vendors?.codex !== false) {
    const homes = codexHomes(env);
    const surviving = await existingRoots(codexRootCandidates(homes), fsPromises);
    // Only when neither sessions/ nor archived_sessions/ exists does the home itself count as a flat
    // JSONL dir; a real ~/.codex also holds history.jsonl and plugin fixtures, which are not usage.
    const fallback = await existingRoots(codexFallbackRoots(homes, surviving), fsPromises);
    for (const root of [...surviving, ...fallback]) roots.push({ vendor: 'codex', dir: root.dir, kind: root.kind });
  }
  if (vendors?.grok !== false) {
    const surviving = await existingRoots(grokRootCandidates(grokHomes(env)), fsPromises);
    for (const root of surviving) roots.push({ vendor: 'grok', dir: root.dir, kind: root.kind });
  }
  return roots;
}

async function existingRoots(candidates, fsPromises) {
  const checks = await Promise.all(candidates.map(async (candidate) => {
    try {
      const stat = await fsPromises.stat(candidate.dir);
      return stat.isDirectory() ? candidate : null;
    } catch {
      return null;
    }
  }));
  return checks.filter(Boolean);
}

async function walkSourceFiles(roots, fsPromises, logger) {
  const files = [];
  for (const root of roots) {
    const found = [];
    await walkDir(root.dir, root.vendor, fsPromises, found, logger);
    for (const file of found) files.push({ file, vendor: root.vendor, kind: root.kind });
  }
  // The same Codex rollout can exist under both sessions/ and archived_sessions/; the active copy wins,
  // since it is the one still being appended to.
  const codexFiles = dedupeCodexFiles(files.filter((entry) => entry.vendor === 'codex'));
  const others = files.filter((entry) => entry.vendor !== 'codex');
  return [...others, ...codexFiles].sort((left, right) => left.file.localeCompare(right.file));
}

async function walkDir(dir, vendor, fsPromises, files, logger) {
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
      await walkDir(fullPath, vendor, fsPromises, files, logger);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isUsageFile(vendor, entry.name)) continue;
    files.push(fullPath);
  }
}

function relativeToProjects(file, dirs) {
  const owner = dirs.find((dir) => file.startsWith(`${dir}${path.sep}`));
  if (!owner) return path.basename(file);
  return path.relative(owner, file);
}

/*
 * Dedup identity, per vendor. Each vendor's own core owns its rule (Codex has no message id, Grok has a
 * prompt id), and both cores put the vendor name in the first segment of the key they return, so a
 * Claude key can never collide with a Codex or Grok one. Pinned by a test.
 */
function keysForEntry(entry, syntheticPrimary = null) {
  if (entry?.vendor === 'codex') return { primary: codexDedupIdentity(entry), collision: null };
  if (entry?.vendor === 'grok') return { primary: grokDedupIdentity(entry), collision: null };
  const keys = dedupKeys(entry);
  return { primary: keys.primary || syntheticPrimary || entry?.[SYNTHETIC_PRIMARY] || null, collision: keys.collision };
}

// Only Codex carries state across lines within a file; the others are line-local.
function createVendorState(vendor) {
  if (vendor === 'codex') return createCodexUsageState();
  return null;
}

function cloneVendorState(vendorState) {
  if (!vendorState) return vendorState;
  return { ...vendorState };
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
  // Grok prices itself, so a Grok model missing from the price table is not a gap in the report.
  if (entry?.vendor === 'grok') return false;
  if (costMode === 'display') return false;
  if (resolved) return false;
  if (priced.priced) return false;
  if (!entry.model) return false;
  return totalTokensOf(entry) > 0;
}

// Absent vendor means Claude: the field was added when other vendors were, and every pre-existing entry
// shape is a Claude one.
function isClaudeEntry(entry) {
  const vendor = typeof entry?.vendor === 'string' ? entry.vendor.trim() : '';
  return vendor === '' || vendor === 'claude';
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
