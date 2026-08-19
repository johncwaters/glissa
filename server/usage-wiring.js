/*
 * Usage tracking wiring - the IO shell that binds server/usage-scanner.js (pure-ish, fs injected) and
 * server/usage-pricing.js to real Sessions, the dashboard broadcast, and the control-WS request.
 *
 * Same shape as server/posthog-wiring.js: createBackend calls createUsageWiring once with its live
 * locals and gets back the verbs it needs (lazy start, per-session nudge, restart on a config change,
 * stop on shutdown, the two message builders). The pure pieces (config resolution, start gate, config
 * key) are exported directly for unit tests.
 *
 * Unlike the PostHog and PR lanes this one is ON by default and needs no credentials, so the gate is
 * config.usage.enabled alone. It starts LAZILY on the first control connection: the initial full
 * transcript scan is the expensive pass and nobody is watching at cold boot.
 */

'use strict';

const path = require('node:path');
const { createUsageScanner } = require('./usage-scanner');
const { loadPricing } = require('./usage-pricing');
const { evaluateBudget, normalizeBudgetConfig } = require('./core/usage-budget-core');
const { decideTelegramNotification } = require('../notifications/channels/telegram');
const { sendTelegramMessage } = require('./telegram-transport');
const {
  buildPlanLimitsMessage,
  normalizeStatuslinePayload,
  shouldBroadcastPlanLimits,
} = require('./core/usage-statusline-core');

const DEFAULT_USAGE_CONFIG = Object.freeze({
  enabled: true,
  fetchPricing: true,
  planLimits: true,
  scanIntervalMinutes: 5,
  retainDays: 90,
  // Durable history retention, independent of transcript retention: the point of the warehouse is to
  // outlive the ~30 days Claude Code keeps its transcripts for.
  warehouseRetainDays: 365,
  sessionBlockHours: 5,
  costMode: 'auto',
  extraProjectsDirs: [],
  // Spend ceilings in USD. Absent (the default) means no budget at all: no meters, no alerts.
  budget: { dailyUsd: null, monthlyUsd: null },
  // Other CLI vendors whose local transcripts are read alongside Claude's. On by default; a false here
  // means that vendor's tree is never walked at all.
  vendors: { codex: true, grok: true },
});

const USAGE_VENDOR_KEYS = Object.freeze(['codex', 'grok']);
// Shared with control-handlers' validateUsage, like the ranges and vendor keys: one source of truth for
// which budget fields exist.
const USAGE_BUDGET_KEYS = Object.freeze(['dailyUsd', 'monthlyUsd']);

/*
 * Claude session ids seen in statusLine payloads, capped. Claude assigns a NEW id on every resume, so
 * an uncapped map would grow for the life of the process on a machine that resumes often.
 */
const OFFICIAL_COST_CAP = 200;

// The Claude transcript is flushed AFTER the Stop hook that ends the turn, so a scan fired on the
// post-turn signal itself would miss the very entries it was triggered by.
const NUDGE_DEBOUNCE_MS = 2000;
/*
 * The scanner caps each pass at a byte budget, so the first pass over a large transcript tree comes
 * back `partial` with only a slice of the entries (measured on a real machine: 6927 files, the budget
 * exhausted, 36 entries). Waiting a full scanIntervalMinutes between those slices would leave the
 * dashboard reporting a fraction of the real cost for hours, so a partial pass is continued on this
 * much shorter timer instead. Deliberately not immediate: each continuation is another budget's worth
 * of disk reads on the event loop every session shares.
 */
const PARTIAL_CONTINUE_MS = 15000;
const FORCE_PASS_MIN_INTERVAL_MS = 3000;
// Shared with control-handlers' validateUsage/sanitizeUsage: one source of truth for the ranges the
// wire validator enforces and the fallback resolver tolerates, so the two cannot drift apart.
const USAGE_COST_MODES = Object.freeze(['auto', 'calculate', 'display']);
const COST_MODES = new Set(USAGE_COST_MODES);
const USAGE_INTEGER_RANGES = Object.freeze({
  scanIntervalMinutes: { min: 1, max: 1440 },
  retainDays: { min: 1, max: 3650 },
  warehouseRetainDays: { min: 30, max: 3650 },
  sessionBlockHours: { min: 1, max: 24 },
});
const INTEGER_RANGES = USAGE_INTEGER_RANGES;

function integerWithin(value, { min, max }, fallback) {
  if (!Number.isInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function absoluteDirList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string' && entry.trim() && path.isAbsolute(entry.trim()))
    .map((entry) => entry.trim());
}

/*
 * config.usage -> a fully populated lane config. An absent block means enabled-with-defaults, so a
 * user who never opens the Usage tab still gets usage tracking and a byte-identical config.json.
 * Defensive rather than strict: control-handlers.js validateUsage REJECTS a bad value on the way in,
 * so anything wrong reaching here came from a hand-edited config.json and falls back to the default.
 */
function resolveUsageConfig(usage) {
  const source = usage != null && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_USAGE_CONFIG.enabled,
    fetchPricing: typeof source.fetchPricing === 'boolean' ? source.fetchPricing : DEFAULT_USAGE_CONFIG.fetchPricing,
    planLimits: typeof source.planLimits === 'boolean' ? source.planLimits : DEFAULT_USAGE_CONFIG.planLimits,
    scanIntervalMinutes: integerWithin(source.scanIntervalMinutes, INTEGER_RANGES.scanIntervalMinutes, DEFAULT_USAGE_CONFIG.scanIntervalMinutes),
    retainDays: integerWithin(source.retainDays, INTEGER_RANGES.retainDays, DEFAULT_USAGE_CONFIG.retainDays),
    warehouseRetainDays: integerWithin(source.warehouseRetainDays, INTEGER_RANGES.warehouseRetainDays, DEFAULT_USAGE_CONFIG.warehouseRetainDays),
    sessionBlockHours: integerWithin(source.sessionBlockHours, INTEGER_RANGES.sessionBlockHours, DEFAULT_USAGE_CONFIG.sessionBlockHours),
    costMode: COST_MODES.has(source.costMode) ? source.costMode : DEFAULT_USAGE_CONFIG.costMode,
    extraProjectsDirs: absoluteDirList(source.extraProjectsDirs),
    vendors: resolveVendors(source.vendors),
    budget: normalizeBudgetConfig(source.budget),
  };
}

// Defensive like every other key here: only an explicit `false` opts a vendor out, so a hand-edited
// garbage value leaves the vendor on rather than silently hiding its usage.
function resolveVendors(vendors) {
  const source = vendors != null && typeof vendors === 'object' && !Array.isArray(vendors) ? vendors : {};
  const resolved = {};
  for (const key of USAGE_VENDOR_KEYS) {
    resolved[key] = source[key] !== false;
  }
  return resolved;
}

// Pure gate for the lane. No credential can be missing here (the data is local transcript files), so
// the only way not to start is an explicit opt-out.
function usageShouldStart(cfg) {
  return resolveUsageConfig(cfg?.usage).enabled;
}

// Identity of the lane-relevant config, compared on every settings reload against the key recorded at
// the last start. A save that touches nothing under `usage` must never restart a scanner mid-pass.
function usageCfgKey(cfg) {
  return JSON.stringify({ usage: cfg?.usage || null });
}

/*
 * The one wording for a budget alert, built here and shipped ON the broadcast so the browser notification
 * and the Telegram message are the same string by construction rather than by two implementations
 * agreeing. Plain text, no dash characters.
 */
function budgetAlertText({ scope, threshold, spentUsd, budgetUsd }) {
  const period = scope === 'monthly' ? 'monthly' : 'daily';
  return `Usage budget: ${period} spend ${formatUsd(spentUsd)} reached ${threshold}% of ${formatUsd(budgetUsd)}`;
}

function formatUsd(value) {
  const number = Number.isFinite(value) ? value : 0;
  return `$${number.toFixed(2)}`;
}

function createUsageWiring({
  config,
  sessions = new Map(),
  broadcast = () => {},
  controlClientCount = () => 0,
  // Beside the resolved config file, so a temp GLISSA_CONFIG keeps its history in the temp dir too (the
  // same rule uploads and recordings follow). Null disables the warehouse entirely.
  warehousePath = null,
  // Which budget thresholds have already fired this period. Beside the config file for the same reason the
  // warehouse is: a temp GLISSA_CONFIG must never write into the operator's real ~/.glissa.
  budgetStatePath = null,
  sendTelegram = sendTelegramMessage,
  fsPromises = require('node:fs/promises'),
  createScanner = createUsageScanner,
  loadPricingFn = loadPricing,
  scannerDeps = {},
  nowFn = Date.now,
  partialContinueMs = PARTIAL_CONTINUE_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
}) {
  let cfg = resolveUsageConfig(config.usage);
  let lastKey = usageCfgKey(config);
  let scanner = null;
  let pricing = null;
  let startPromise = null;
  let startRequested = false;
  let stopped = false;
  let passInFlight = false;
  let intervalTimer = null;
  let nudgeTimer = null;
  let continueTimer = null;
  let restartChain = Promise.resolve();
  let lastSessionsMessage = null;
  let lastSessionsSignature = null;
  let lastReportMessage = null;
  let lastForcedPassMs = 0;
  // Plan limits are a property of the ACCOUNT, not of a session, so one freshest snapshot serves every
  // card and every connected client.
  let planLimits = null;
  const officialCostByClaudeId = new Map();
  let budgetFiredState = {};
  let budgetStateLoaded = false;
  let budgetStateSignature = null;

  function warn(message) {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[usage] ${message}`);
  }

  async function loadPricingSafely() {
    try {
      return await loadPricingFn({ fetchEnabled: cfg.fetchPricing, logger });
    } catch (error) {
      warn(`pricing load failed: ${error.message}`);
      return { table: {}, source: 'unavailable', fetchedAt: null };
    }
  }

  /*
   * Lazy start, idempotent and single-flight: every control connection calls it and only the first one
   * pays for the initial scan. A disabled lane constructs NO scanner, so `enabled: false` walks no
   * directory and reads no file.
   */
  function start() {
    if (startPromise) return startPromise;
    if (stopped) return Promise.resolve();
    startRequested = true;
    cfg = resolveUsageConfig(config.usage);
    lastKey = usageCfgKey(config);
    if (!usageShouldStart(config)) return Promise.resolve();
    startPromise = (async () => {
      pricing = await loadPricingSafely();
      if (stopped) return;
      scanner = createScanner({
        pricingTable: pricing.table,
        costMode: cfg.costMode,
        blockHours: cfg.sessionBlockHours,
        retainDays: cfg.retainDays,
        extraProjectsDirs: cfg.extraProjectsDirs,
        vendors: cfg.vendors,
        warehousePath,
        warehouseRetainDays: cfg.warehouseRetainDays,
        budget: cfg.budget,
        logger,
        ...scannerDeps,
      });
      await runPassAndPush({ force: false });
      armInterval();
    })().catch((error) => warn(`start failed: ${error.message}`));
    return startPromise;
  }

  function armInterval() {
    if (stopped || intervalTimer) return;
    intervalTimer = setIntervalFn(onIntervalTick, cfg.scanIntervalMinutes * 60 * 1000);
    if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref();
  }

  // Nothing to serve a fresh scan to with no dashboard open, and re-entering a pass that is already
  // walking the transcript tree would only queue redundant fs work on the shared event loop.
  function onIntervalTick() {
    if (stopped || !scanner) return;
    if (controlClientCount() === 0) return;
    if (passInFlight) return;
    void runPassAndPush({ force: false });
  }

  async function runPassAndPush({ force }) {
    if (stopped || !scanner) return null;
    passInFlight = true;
    let result = null;
    try {
      result = await scanner.runPass({ force });
    } catch (error) {
      warn(`scan pass failed: ${error.message}`);
    } finally {
      passInFlight = false;
    }
    if (stopped) return result;
    // The first pass pushes unconditionally so a dashboard learns the pricing source and an empty
    // baseline even on a machine with no transcripts yet.
    if (lastSessionsMessage === null || (result && result.newEntries > 0)) pushSessions();
    // Budgets are evaluated only on a COMPLETE pass, for the same reason the warehouse only writes on one:
    // a partial pass has seen an arbitrary slice of the tree, and firing a once-per-period alert off an
    // undercount would burn that threshold for the rest of the period.
    if (result && !result.partial) await evaluateBudgets();
    if (result?.partial) scheduleContinuation();
    return result;
  }

  // Resume a budget-truncated scan. Skipped with no dashboard open: the tree is only worth finishing
  // for someone who is looking, and the interval tick picks it back up when one connects.
  function scheduleContinuation() {
    if (stopped || !scanner || continueTimer) return;
    if (controlClientCount() === 0) return;
    continueTimer = setTimeout(() => {
      continueTimer = null;
      if (stopped || !scanner || passInFlight) return;
      void runPassAndPush({ force: false });
    }, partialContinueMs);
    if (typeof continueTimer.unref === 'function') continueTimer.unref();
  }

  /*
   * Per-session refresh on the post-turn signal, debounced once for the whole lane: two sessions
   * ending a turn together want ONE scan, not two walks of the same tree. Never starts the lane (a
   * turn ending with no dashboard ever opened must not trigger the expensive initial pass).
   */
  function nudgeSession() {
    if (stopped || !scanner) return;
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      if (stopped || !scanner) return;
      // A pass already reading joined here and stat'd the file pre-turn; re-arm so the new bytes are seen.
      if (passInFlight) {
        nudgeSession();
        return;
      }
      void runPassAndPush({ force: false });
    }, NUDGE_DEBOUNCE_MS);
    if (typeof nudgeTimer.unref === 'function') nudgeTimer.unref();
  }

  /*
   * Per-card totals: each REAL session's live Claude session id mapped through the scanner's in-line
   * sessionId attribution. A session with no captured id is skipped entirely (nothing identifies its
   * transcript); one with an id but no entries yet reports zeros, so a stale chip clears.
   */
  function getSessionsMessage() {
    if (!scanner) return null;
    const totals = scanner.sessionTotals();
    const rows = [];
    for (const [id, sess] of sessions) {
      if (sess.ephemeral) continue;
      const claudeSessionId = sess.resumeSessionId;
      if (!claudeSessionId) continue;
      const bucket = totals.get(claudeSessionId) || { tokens: 0, costUSD: 0, lastTs: null };
      // Claude's own figure for this conversation when a statusLine callback has reported one. Kept
      // beside the scanner's estimate rather than replacing it: they are computed differently, and the
      // card labels which one it is showing.
      const officialCostUSD = officialCostByClaudeId.has(claudeSessionId)
        ? officialCostByClaudeId.get(claudeSessionId)
        : null;
      rows.push({ id, tokens: bucket.tokens, costUSD: bucket.costUSD, lastTs: bucket.lastTs, officialCostUSD });
    }
    return { type: 'usage-sessions', ts: nowFn(), pricingSource: pricing?.source || null, sessions: rows };
  }

  // Every hook callback can re-emit the same claude-session-id map, and a pass that changed only
  // unattributed entries changes no row, so an identical payload is dropped rather than broadcast.
  function pushSessions() {
    const message = getSessionsMessage();
    if (!message) return;
    const signature = JSON.stringify(message.sessions);
    if (signature === lastSessionsSignature) return;
    lastSessionsSignature = signature;
    lastSessionsMessage = message;
    broadcast(message);
  }

  function refreshSessions() {
    if (stopped || !scanner) return;
    pushSessions();
  }

  // Fires per assistant/tool step of every live turn on the shared event loop: O(1), no fs, and the
  // raw payload is neither stored nor recorded (it carries transcript path, cwd, prompt id).
  function ingestStatusline(payload) {
    // usage.enabled false must silence sessions spawned before the flip, not just stop new injection.
    if (stopped || !cfg.enabled || !cfg.planLimits) return;
    const snapshot = normalizeStatuslinePayload(payload, nowFn());
    if (!snapshot) return;
    rememberOfficialCost(snapshot);
    if (!snapshot.rateLimits) return;
    // Latest wins. The ts is our own receive clock, so this only ever guards against a reordered pair.
    if (planLimits && snapshot.ts < planLimits.ts) return;
    const changed = shouldBroadcastPlanLimits(planLimits, snapshot);
    planLimits = snapshot;
    if (!changed) return;
    const message = buildPlanLimitsMessage(snapshot);
    if (message) broadcast(message);
  }

  // Claude's own cumulative estimate for one conversation, keyed by the Claude session id (the same key
  // the per-card attribution already uses). Re-inserted rather than updated in place so the eviction
  // below drops the least recently SEEN id, not the oldest one.
  function rememberOfficialCost(snapshot) {
    if (!snapshot.claudeSessionId || snapshot.sessionCostUSD === null) return;
    officialCostByClaudeId.delete(snapshot.claudeSessionId);
    officialCostByClaudeId.set(snapshot.claudeSessionId, snapshot.sessionCostUSD);
    if (officialCostByClaudeId.size <= OFFICIAL_COST_CAP) return;
    const oldest = officialCostByClaudeId.keys().next();
    if (!oldest.done) officialCostByClaudeId.delete(oldest.value);
  }

  // Gated on the read as well as the write, so switching the lane off stops serving a snapshot it
  // already holds (the cfg key covers `planLimits`, so a save re-resolves cfg through the restart).
  function getPlanLimitsMessage() {
    if (!cfg.enabled || !cfg.planLimits) return null;
    return buildPlanLimitsMessage(planLimits);
  }

  // ── Budgets ──
  // A threshold fires once per period. The fired state is on disk because the alternative is re-alerting
  // 50/75/100 on every restart, which is exactly how an alert channel teaches its operator to ignore it.

  async function loadBudgetState() {
    if (budgetStateLoaded || !budgetStatePath) return;
    budgetStateLoaded = true;
    let text = null;
    try {
      text = await fsPromises.readFile(budgetStatePath, 'utf8');
    } catch {
      // No file yet is the ordinary first-run case.
      return;
    }
    try {
      const parsed = JSON.parse(text);
      budgetFiredState = parsed && typeof parsed === 'object' && parsed.fired && typeof parsed.fired === 'object' ? parsed.fired : {};
    } catch (error) {
      // Starting empty can only ever RE-fire an alert, never suppress a real one, so this fails toward noise
      // rather than silence.
      warn(`budget state unreadable, starting empty: ${error.message}`);
      budgetFiredState = {};
    }
  }

  async function evaluateBudgets() {
    if (stopped || !scanner || !budgetStatePath) return;
    const normalized = normalizeBudgetConfig(cfg.budget);
    if (normalized.dailyUsd === null && normalized.monthlyUsd === null) return;
    await loadBudgetState();
    const spend = scanner.budgetSpend();
    const { alerts, firedState } = evaluateBudget({
      budget: normalized,
      todayUsd: spend.todayUsd,
      monthUsd: spend.monthUsd,
      todayKey: spend.todayKey,
      monthKey: spend.monthKey,
    }, budgetFiredState);
    budgetFiredState = firedState;
    if (alerts.length === 0) {
      // The prune inside evaluateBudget drops last period's marks, so a rollover still needs a write.
      await saveBudgetState();
      return;
    }
    for (const alert of alerts) {
      const message = { type: 'usage-budget-alert', ...alert, text: budgetAlertText(alert), ts: nowFn() };
      broadcast(message);
      deliverBudgetTelegram(alert);
    }
    await saveBudgetState();
  }

  async function saveBudgetState() {
    if (!budgetStatePath) return;
    const payload = `${JSON.stringify({ version: 1, fired: budgetFiredState }, null, 2)}\n`;
    const signature = JSON.stringify(budgetFiredState);
    if (signature === budgetStateSignature) return;
    budgetStateSignature = signature;
    const tmpPath = `${budgetStatePath}.tmp`;
    try {
      await fsPromises.mkdir(path.dirname(budgetStatePath), { recursive: true });
      await fsPromises.writeFile(tmpPath, payload);
      await fsPromises.rename(tmpPath, budgetStatePath);
    } catch (error) {
      warn(`budget state write failed: ${error.message}`);
      budgetStateSignature = null;
    }
  }

  /*
   * Same rule the session channel applies: ping the phone only when nobody would see the browser
   * notification. The gate itself is decideTelegramNotification, reused rather than reimplemented, so the
   * two channels cannot drift on what "nobody is watching" means.
   */
  function deliverBudgetTelegram(alert) {
    const decision = decideTelegramNotification({
      enabled: config.telegramNotifications === true,
      botToken: config.telegram?.botToken,
      chatId: config.telegram?.chatId,
      connectionCount: controlClientCount(),
    });
    if (!decision.send) return;
    void Promise.resolve(sendTelegram({
      botToken: config.telegram.botToken,
      chatId: config.telegram.chatId,
      text: budgetAlertText(alert),
    })).catch(() => {});
  }

  function unavailableReport(requestId, error) {
    return { type: 'usage-report', requestId: requestId || null, ts: nowFn(), error };
  }

  /*
   * The pulled half of the protocol: the full report is large, so it travels only in reply to
   * `request-usage-report`. `force` re-reads every transcript from offset zero (the operator asking
   * for a hard refresh); the default pass is incremental.
   */
  async function requestReport({ days, force = false, requestId = null } = {}) {
    await start();
    if (!scanner) return unavailableReport(requestId, 'Usage tracking is disabled');
    // A forced pass rebuilds the whole store; rate-limit it so a looping client cannot queue
    // back-to-back full rescans onto the shared event loop (posthog FORCE_TICK_DEBOUNCE_MS precedent).
    const allowForce = force && nowFn() - lastForcedPassMs >= FORCE_PASS_MIN_INTERVAL_MS;
    if (allowForce) lastForcedPassMs = nowFn();
    if (force) await runPassAndPush({ force: allowForce });
    let report = null;
    try {
      report = scanner.buildReport({ days });
    } catch (error) {
      warn(`report build failed: ${error.message}`);
      return unavailableReport(requestId, `Usage report failed: ${error.message}`);
    }
    const scanStats = scanner.stats();
    const cached = {
      type: 'usage-report',
      requestId: null,
      ts: report.ts,
      tz: report.tz,
      blockHours: report.blockHours,
      totals: report.totals,
      daily: report.daily,
      models: report.models,
      sessions: report.sessions,
      blocks: report.blocks,
      activeBlock: report.activeBlock,
      anomaly: report.anomaly,
      tokenLimit: report.tokenLimit,
      pricing: { source: pricing.source, fetchedAt: pricing.fetchedAt, missing: report.pricing.missing },
      scan: {
        dirs: report.scan.dirs,
        files: report.scan.files,
        entries: report.scan.entries,
        lastScanMs: report.scan.lastScanMs,
        partial: report.scan.partial,
      },
      // A dir-resolution failure (CLAUDE_CONFIG_DIR set but empty) yields a report of zeros that
      // would otherwise read as "you have no usage" rather than "Glissa could not look".
      warning: scanStats.resolutionError || null,
      error: null,
    };
    lastReportMessage = cached;
    return { ...cached, requestId: requestId || null };
  }

  function clearTimers() {
    if (intervalTimer) {
      clearIntervalFn(intervalTimer);
      intervalTimer = null;
    }
    if (nudgeTimer) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
    if (continueTimer) {
      clearTimeout(continueTimer);
      continueTimer = null;
    }
  }

  async function teardown() {
    clearTimers();
    if (startPromise) await startPromise.catch(() => {});
    // An in-flight start() resumes after the await and re-arms timers into the cleared slots.
    clearTimers();
    startPromise = null;
    scanner = null;
    pricing = null;
    lastSessionsMessage = null;
    lastSessionsSignature = null;
    lastReportMessage = null;
  }

  /*
   * Hot-apply a settings save. Serialized through restartChain so an in-flight start or pass finishes
   * before a fresh scanner replaces it, and gated on the config key so an unrelated save (cursorBlink)
   * never throws away a warm entry store. A lane that was never started stays lazy: the key is
   * recorded and the next control connection builds the scanner with the new config.
   */
  function restartIfConfigChanged() {
    if (usageCfgKey(config) === lastKey) return;
    lastKey = usageCfgKey(config);
    restartChain = restartChain.then(async () => {
      if (stopped) return;
      await teardown();
      if (!startRequested) return;
      await start();
    }).catch((error) => warn(`restart failed: ${error.message}`));
  }

  async function stop() {
    stopped = true;
    clearTimers();
    if (startPromise) await startPromise.catch(() => {});
    await restartChain.catch(() => {});
    scanner = null;
  }

  return {
    start,
    stop,
    nudgeSession,
    refreshSessions,
    restartIfConfigChanged,
    getSessionsMessage,
    getCachedReport: () => lastReportMessage,
    requestReport,
    ingestStatusline,
    getPlanLimitsMessage,
  };
}

module.exports = {
  createUsageWiring,
  resolveUsageConfig,
  usageShouldStart,
  usageCfgKey,
  DEFAULT_USAGE_CONFIG,
  NUDGE_DEBOUNCE_MS,
  PARTIAL_CONTINUE_MS,
  USAGE_INTEGER_RANGES,
  USAGE_COST_MODES,
  USAGE_VENDOR_KEYS,
  USAGE_BUDGET_KEYS,
  budgetAlertText,
};
