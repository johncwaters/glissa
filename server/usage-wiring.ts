import nodeFsPromises from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { decideTelegramNotification } from '../notifications/channels/telegram.ts';
import { USAGE_INTEGER_RANGES } from '../shared/settings-ranges.ts';
import { USAGE_BUDGET_KEYS, USAGE_COST_MODES, USAGE_VENDOR_KEYS } from '../shared/usage-config.ts';
import type { UsageVendorKey } from '../shared/usage-config.ts';
import { execFileAsync as defaultExecFileAsync } from './child-process-safe.ts';
import { evaluateBudget, normalizeBudgetConfig } from './core/usage-budget-core.ts';
import type { BudgetAlert, BudgetConfig, BudgetFiredState } from './core/usage-budget-core.ts';
import { computeCacheSavings, normalizeRtkGain } from './core/usage-savings-core.ts';
import {
  buildPlanLimitsMessage,
  normalizeStatuslinePayload,
  shouldBroadcastPlanLimits,
} from './core/usage-statusline-core.ts';
import type { StatuslineSnapshot } from './core/usage-statusline-core.ts';
import { createJsonStateWriter } from './json-file.ts';
import { sendTelegramMessage } from './telegram-transport.ts';
import { loadPricing } from './usage-pricing.ts';
import type { PricingResult } from './usage-pricing.ts';
import { createUsageScanner } from './usage-scanner.ts';
import type { UsageScannerApi, UsageScannerOptions } from './usage-scanner.ts';

const DEFAULT_USAGE_CONFIG = Object.freeze({
  enabled: true,
  fetchPricing: true,
  planLimits: true,

  rtkSavings: true,
  scanIntervalMinutes: 5,
  retainDays: 90,

  warehouseRetainDays: 365,
  sessionBlockHours: 5,
  costMode: 'auto',
  extraProjectsDirs: [],

  budget: { dailyUsd: null, monthlyUsd: null },

  vendors: { codex: true, grok: true },
});

const OFFICIAL_COST_CAP = 200;

const NUDGE_DEBOUNCE_MS = 2000;

const PARTIAL_CONTINUE_MS = 15000;
const FORCE_PASS_MIN_INTERVAL_MS = 3000;

const RTK_SAVINGS_TTL_MS = 60000;
const RTK_GAIN_ARGS = Object.freeze(['gain', '--daily', '--format', 'json']);
const RTK_GAIN_TIMEOUT_MS = 5000;
const RTK_GAIN_MAX_BUFFER = 4 * 1024 * 1024;
const RTK_UNAVAILABLE = Object.freeze({ available: false });

const requireFromHere = createRequire(import.meta.url);
function defaultRtkPath(): string | null {
  return (requireFromHere('./rtk-resolver.ts') as typeof import('./rtk-resolver.ts')).getRtkPath();
}
const COST_MODES = new Set<string>(USAGE_COST_MODES);
const INTEGER_RANGES = USAGE_INTEGER_RANGES;

interface UsageLaneConfig {
  enabled: boolean;
  fetchPricing: boolean;
  planLimits: boolean;
  rtkSavings: boolean;
  scanIntervalMinutes: number;
  retainDays: number;
  warehouseRetainDays: number;
  sessionBlockHours: number;
  costMode: string;
  extraProjectsDirs: string[];
  vendors: Record<UsageVendorKey, boolean>;
  budget: BudgetConfig;
}

interface WiringConfig {
  usage?: unknown;
  telegramNotifications?: boolean;
  telegram?: { botToken?: string; chatId?: string } | null;
}

interface WiringSession {
  ephemeral?: boolean;
  resumeSessionId?: string | null;
}

type SessionsMessage = {
  type: string;
  ts: number;
  pricingSource: string | null;
  sessions: {
    id: string;
    tokens: number;
    costUSD: number;
    lastTs: number | null;
    officialCostUSD: number | null | undefined;
  }[];
};

type RtkSavings = { available: boolean } & Record<string, unknown>;

interface UsageWiringOptions {
  config: WiringConfig;
  sessions?: Map<string, WiringSession>;
  broadcast?: (message: Record<string, unknown>) => void;
  controlClientCount?: () => number;
  warehousePath?: string | null;
  budgetStatePath?: string | null;
  laneMap?: (() => Map<string, string>) | null;
  sendTelegram?: typeof sendTelegramMessage;
  fsPromises?: typeof nodeFsPromises;
  createScanner?: (deps?: UsageScannerOptions) => UsageScannerApi;
  loadPricingFn?: typeof loadPricing;
  execFileAsync?: typeof defaultExecFileAsync;
  rtkPathFn?: () => string | null;
  scannerDeps?: Record<string, unknown>;
  nowFn?: () => number;
  partialContinueMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  logger?: Pick<Console, 'warn' | 'log'>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function integerWithin(value: unknown, { min, max }: { min: number; max: number }, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  const numeric = Number(value);
  if (numeric < min || numeric > max) return fallback;
  return numeric;
}

function absoluteDirList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()) && path.isAbsolute(entry.trim()))
    .map((entry) => entry.trim());
}

function resolveVendors(vendors: unknown): Record<UsageVendorKey, boolean> {
  const source = (vendors != null && typeof vendors === 'object' && !Array.isArray(vendors)
    ? vendors
    : {}) as Record<string, unknown>;
  const resolved = {} as Record<UsageVendorKey, boolean>;
  for (const key of USAGE_VENDOR_KEYS) {
    resolved[key] = source[key] !== false;
  }
  return resolved;
}

function resolveUsageConfig(usage: unknown): UsageLaneConfig {
  const source = (usage != null && typeof usage === 'object' && !Array.isArray(usage)
    ? usage
    : {}) as Record<string, unknown>;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_USAGE_CONFIG.enabled,
    fetchPricing: typeof source.fetchPricing === 'boolean' ? source.fetchPricing : DEFAULT_USAGE_CONFIG.fetchPricing,
    planLimits: typeof source.planLimits === 'boolean' ? source.planLimits : DEFAULT_USAGE_CONFIG.planLimits,
    rtkSavings: typeof source.rtkSavings === 'boolean' ? source.rtkSavings : DEFAULT_USAGE_CONFIG.rtkSavings,
    scanIntervalMinutes: integerWithin(source.scanIntervalMinutes, INTEGER_RANGES.scanIntervalMinutes, DEFAULT_USAGE_CONFIG.scanIntervalMinutes),
    retainDays: integerWithin(source.retainDays, INTEGER_RANGES.retainDays, DEFAULT_USAGE_CONFIG.retainDays),
    warehouseRetainDays: integerWithin(source.warehouseRetainDays, INTEGER_RANGES.warehouseRetainDays, DEFAULT_USAGE_CONFIG.warehouseRetainDays),
    sessionBlockHours: integerWithin(source.sessionBlockHours, INTEGER_RANGES.sessionBlockHours, DEFAULT_USAGE_CONFIG.sessionBlockHours),
    costMode: typeof source.costMode === 'string' && COST_MODES.has(source.costMode) ? source.costMode : DEFAULT_USAGE_CONFIG.costMode,
    extraProjectsDirs: absoluteDirList(source.extraProjectsDirs),
    vendors: resolveVendors(source.vendors),
    budget: normalizeBudgetConfig(source.budget as { dailyUsd?: unknown; monthlyUsd?: unknown } | null),
  };
}

function usageShouldStart(cfg: { usage?: unknown } | null | undefined): boolean {
  return resolveUsageConfig(cfg?.usage).enabled;
}

function usageCfgKey(cfg: { usage?: unknown } | null | undefined): string {
  return JSON.stringify({ usage: cfg?.usage || null });
}

function formatBudgetUsd(value: unknown): string {
  const number = Number.isFinite(value) ? Number(value) : 0;
  return `$${number.toFixed(2)}`;
}

function budgetAlertText(
  { scope, threshold, spentUsd, budgetUsd }: { scope?: unknown; threshold?: unknown; spentUsd?: unknown; budgetUsd?: unknown },
): string {
  const period = scope === 'monthly' ? 'monthly' : 'daily';
  return `Usage budget: ${period} spend ${formatBudgetUsd(spentUsd)} reached ${threshold}% of ${formatBudgetUsd(budgetUsd)}`;
}

function createUsageWiring({
  config,
  sessions = new Map(),
  broadcast = () => {},
  controlClientCount = () => 0,

  warehousePath = null,

  budgetStatePath = null,

  laneMap = null,
  sendTelegram = sendTelegramMessage,
  fsPromises = nodeFsPromises,
  createScanner = createUsageScanner,
  loadPricingFn = loadPricing,

  execFileAsync = defaultExecFileAsync,
  rtkPathFn = defaultRtkPath,
  scannerDeps = {},
  nowFn = Date.now,
  partialContinueMs = PARTIAL_CONTINUE_MS,
  setIntervalFn = (fn: () => void, ms: number) => setInterval(fn, ms),
  clearIntervalFn = clearInterval,
  logger = console,
}: UsageWiringOptions) {
  let cfg = resolveUsageConfig(config.usage);
  let lastKey = usageCfgKey(config);
  let scanner: UsageScannerApi | null = null;
  let pricing: PricingResult | null = null;
  let startPromise: Promise<void> | null = null;
  let startRequested = false;
  let stopped = false;
  let passInFlight = false;
  let intervalTimer: NodeJS.Timeout | null = null;
  let nudgeTimer: NodeJS.Timeout | null = null;
  let continueTimer: NodeJS.Timeout | null = null;
  let restartChain: Promise<void> = Promise.resolve();
  let lastSessionsMessage: SessionsMessage | null = null;
  let lastSessionsSignature: string | null = null;
  let lastReportMessage: Record<string, unknown> | null = null;
  let lastForcedPassMs = 0;

  let planLimits: StatuslineSnapshot | null = null;
  const officialCostByClaudeId = new Map<string, number>();
  let budgetFiredState: BudgetFiredState | Record<string, never> = {};
  let budgetStateLoaded = false;

  function warn(message: string): void {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[usage] ${message}`);
  }

  const budgetStateWriter = budgetStatePath
    ? createJsonStateWriter({
      filePath: budgetStatePath,
      fsPromises,
      warn: (error: unknown) => warn(`budget state write failed: ${errorMessage(error)}`),
    })
    : null;
  let rtkSavingsCache: RtkSavings | null = null;
  let rtkSavingsCacheMs = 0;
  let warnedRtkGain = false;

  async function loadPricingSafely(): Promise<PricingResult> {
    try {
      return await loadPricingFn({ fetchEnabled: cfg.fetchPricing, logger });
    } catch (error) {
      warn(`pricing load failed: ${errorMessage(error)}`);
      return { table: new Map(), source: 'unavailable', fetchedAt: null };
    }
  }

  function armInterval(): void {
    if (stopped || intervalTimer) return;
    intervalTimer = setIntervalFn(onIntervalTick, cfg.scanIntervalMinutes * 60 * 1000);
    if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref();
  }

  function onIntervalTick(): void {
    if (stopped || !scanner) return;
    if (controlClientCount() === 0) return;
    if (passInFlight) return;
    void runPassAndPush({ force: false });
  }

  function start(): Promise<void> {
    if (startPromise) return startPromise;
    if (stopped) return Promise.resolve();
    startRequested = true;
    cfg = resolveUsageConfig(config.usage);
    lastKey = usageCfgKey(config);
    if (!usageShouldStart(config)) return Promise.resolve();
    startPromise = (async () => {
      const loadedPricing = await loadPricingSafely();
      pricing = loadedPricing;
      if (stopped) return;
      scanner = createScanner({
        pricingTable: loadedPricing.table,
        costMode: cfg.costMode,
        blockHours: cfg.sessionBlockHours,
        retainDays: cfg.retainDays,
        extraProjectsDirs: cfg.extraProjectsDirs,
        vendors: cfg.vendors,
        warehousePath,
        warehouseRetainDays: cfg.warehouseRetainDays,
        budget: cfg.budget,
        laneMap,
        logger,
        ...scannerDeps,
      });
      await runPassAndPush({ force: false });
      armInterval();
    })().catch((error: unknown) => warn(`start failed: ${errorMessage(error)}`));
    return startPromise;
  }

  async function runPassAndPush({ force }: { force: boolean }) {
    if (stopped || !scanner) return null;
    passInFlight = true;
    let result: Awaited<ReturnType<ReturnType<typeof createUsageScanner>['runPass']>> | null = null;
    try {
      result = await scanner.runPass({ force });
    } catch (error) {
      warn(`scan pass failed: ${errorMessage(error)}`);
    } finally {
      passInFlight = false;
    }
    if (stopped) return result;

    if (lastSessionsMessage === null || (result && result.newEntries > 0)) pushSessions();

    if (result && !result.partial) await evaluateBudgets();
    if (result?.partial) scheduleContinuation();
    return result;
  }

  function scheduleContinuation(): void {
    if (stopped || !scanner || continueTimer) return;
    if (controlClientCount() === 0) return;
    continueTimer = setTimeout(() => {
      continueTimer = null;
      if (stopped || !scanner || passInFlight) return;
      void runPassAndPush({ force: false });
    }, partialContinueMs);
    if (typeof continueTimer.unref === 'function') continueTimer.unref();
  }

  function nudgeSession(): void {
    if (stopped || !scanner) return;
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      if (stopped || !scanner) return;

      if (passInFlight) {
        nudgeSession();
        return;
      }
      void runPassAndPush({ force: false });
    }, NUDGE_DEBOUNCE_MS);
    if (typeof nudgeTimer.unref === 'function') nudgeTimer.unref();
  }

  function getSessionsMessage(): SessionsMessage | null {
    if (!scanner) return null;
    const totals = scanner.sessionTotals();
    const rows: SessionsMessage['sessions'] = [];
    for (const [id, sess] of sessions) {
      if (sess.ephemeral) continue;
      const resumeId = sess.resumeSessionId;
      if (!resumeId) continue;
      const bucket = totals.get(resumeId) || { tokens: 0, costUSD: 0, lastTs: null };

      const officialCostUSD = officialCostByClaudeId.has(resumeId)
        ? officialCostByClaudeId.get(resumeId)
        : null;
      rows.push({ id, tokens: bucket.tokens, costUSD: bucket.costUSD, lastTs: bucket.lastTs, officialCostUSD });
    }
    return { type: 'usage-sessions', ts: nowFn(), pricingSource: pricing?.source || null, sessions: rows };
  }

  function sessionTotals(sessionId: string): { tokens: number; costUSD: number; lastTs: number | null } | null {
    if (!scanner) return null;
    const resumeId = sessions.get(sessionId)?.resumeSessionId;
    if (!resumeId) return null;
    const bucket = scanner.sessionTotals().get(resumeId);
    if (!bucket) return null;
    return { tokens: bucket.tokens, costUSD: bucket.costUSD, lastTs: bucket.lastTs ?? null };
  }

  function pushSessions(): void {
    const message = getSessionsMessage();
    if (!message) return;
    const signature = JSON.stringify(message.sessions);
    if (signature === lastSessionsSignature) return;
    lastSessionsSignature = signature;
    lastSessionsMessage = message;
    broadcast(message);
  }

  function refreshSessions(): void {
    if (stopped || !scanner) return;
    pushSessions();
  }

  function rememberOfficialCost(snapshot: StatuslineSnapshot): void {
    if (!snapshot.claudeSessionId || snapshot.sessionCostUSD === null) return;
    officialCostByClaudeId.delete(snapshot.claudeSessionId);
    officialCostByClaudeId.set(snapshot.claudeSessionId, snapshot.sessionCostUSD);
    if (officialCostByClaudeId.size <= OFFICIAL_COST_CAP) return;
    const oldest = officialCostByClaudeId.keys().next();
    if (!oldest.done) officialCostByClaudeId.delete(oldest.value);
  }

  function ingestStatusline(payload: unknown): void {

    if (stopped || !cfg.enabled || !cfg.planLimits) return;
    const snapshot = normalizeStatuslinePayload(payload, nowFn());
    if (!snapshot) return;
    rememberOfficialCost(snapshot);
    if (!snapshot.rateLimits) return;

    if (planLimits && snapshot.ts < planLimits.ts) return;
    const changed = shouldBroadcastPlanLimits(planLimits, snapshot);
    planLimits = snapshot;
    if (!changed) return;
    const message = buildPlanLimitsMessage(snapshot);
    if (message) broadcast(message);
  }

  function getPlanLimitsMessage() {
    if (!cfg.enabled || !cfg.planLimits) return null;
    return buildPlanLimitsMessage(planLimits);
  }

  async function loadBudgetState(): Promise<void> {
    if (budgetStateLoaded || !budgetStatePath) return;
    budgetStateLoaded = true;
    let text: string | null = null;
    try {
      text = await fsPromises.readFile(budgetStatePath, 'utf8');
    } catch {

      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const fired = parsed && typeof parsed === 'object' ? (parsed as { fired?: unknown }).fired : null;
      budgetFiredState = fired && typeof fired === 'object' ? (fired as BudgetFiredState) : {};
    } catch (error) {

      warn(`budget state unreadable, starting empty: ${errorMessage(error)}`);
      budgetFiredState = {};
    }
  }

  async function saveBudgetState(): Promise<void> {
    if (!budgetStateWriter) return;
    await budgetStateWriter.write(
      budgetFiredState,
      () => `${JSON.stringify({ version: 1, fired: budgetFiredState }, null, 2)}\n`,
    );
  }

  function deliverBudgetTelegram(alert: BudgetAlert): void {
    const decision = decideTelegramNotification({
      enabled: config.telegramNotifications === true,
      botToken: config.telegram?.botToken || '',
      chatId: config.telegram?.chatId || '',
      connectionCount: controlClientCount(),
    });
    if (!decision.send) return;
    const telegram = config.telegram;
    if (!telegram?.botToken || !telegram.chatId) return;
    void Promise.resolve(sendTelegram({
      botToken: telegram.botToken,
      chatId: telegram.chatId,
      text: budgetAlertText(alert),
    })).catch(() => {});
  }

  async function evaluateBudgets(): Promise<void> {
    if (stopped || !scanner || !budgetStatePath) return;

    if (cfg.budget.dailyUsd === null && cfg.budget.monthlyUsd === null) return;
    await loadBudgetState();
    const spend = scanner.budgetSpend();
    const { alerts, firedState } = evaluateBudget({
      budget: cfg.budget,
      todayUsd: spend.todayUsd,
      monthUsd: spend.monthUsd,
      todayKey: spend.todayKey,
      monthKey: spend.monthKey,
    }, budgetFiredState);
    budgetFiredState = firedState;
    if (alerts.length === 0) {

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

  function warnRtkOnce(message: string): RtkSavings {
    if (!warnedRtkGain) {
      warnedRtkGain = true;
      warn(message);
    }
    return RTK_UNAVAILABLE;
  }

  async function fetchRtkSavings(): Promise<RtkSavings> {
    if (!cfg.rtkSavings) return RTK_UNAVAILABLE;
    const rtkPath = rtkPathFn();
    if (!rtkPath) return RTK_UNAVAILABLE;
    if (rtkSavingsCache && nowFn() - rtkSavingsCacheMs < RTK_SAVINGS_TTL_MS) return rtkSavingsCache;
    try {
      const { stdout } = await execFileAsync(rtkPath, [...RTK_GAIN_ARGS], {
        timeout: RTK_GAIN_TIMEOUT_MS,
        maxBuffer: RTK_GAIN_MAX_BUFFER,
        encoding: 'utf8',
      });
      const normalized = normalizeRtkGain(JSON.parse(stdout));
      if (!normalized) return warnRtkOnce('rtk gain reported an unrecognized shape');
      rtkSavingsCache = { available: true, ...normalized };
      rtkSavingsCacheMs = nowFn();
      return rtkSavingsCache;
    } catch (error) {
      return warnRtkOnce(`rtk gain failed: ${errorMessage(error)}`);
    }
  }

  async function buildSavings(report: { models: { model?: string | null; vendor?: string; cacheRead?: unknown }[] }) {
    try {
      return { rtk: await fetchRtkSavings(), cache: computeCacheSavings(report.models, pricing?.table) };
    } catch (error) {
      warn(`savings unavailable: ${errorMessage(error)}`);
      return { rtk: RTK_UNAVAILABLE, cache: null };
    }
  }

  function unavailableReport(requestId: string | null, error: string) {
    return { type: 'usage-report', requestId: requestId || null, ts: nowFn(), error };
  }

  async function requestReport(
    { days, force = false, requestId = null }: { days?: number; force?: boolean; requestId?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    await start();
    if (!scanner || !pricing) return unavailableReport(requestId, 'Usage tracking is disabled');

    const allowForce = force && nowFn() - lastForcedPassMs >= FORCE_PASS_MIN_INTERVAL_MS;
    if (allowForce) lastForcedPassMs = nowFn();
    if (force) await runPassAndPush({ force: allowForce });
    let report: ReturnType<ReturnType<typeof createUsageScanner>['buildReport']>;
    try {
      report = scanner.buildReport({ days });
    } catch (error) {
      warn(`report build failed: ${errorMessage(error)}`);
      return unavailableReport(requestId, `Usage report failed: ${errorMessage(error)}`);
    }
    const scanStats = scanner.stats();
    const savings = await buildSavings(report);
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
      byLane: report.byLane,
      budget: report.budget,
      savings,
      tokenLimit: report.tokenLimit,
      pricing: { source: pricing.source, fetchedAt: pricing.fetchedAt, missing: report.pricing.missing },
      scan: {
        dirs: report.scan.dirs,
        files: report.scan.files,
        entries: report.scan.entries,
        lastScanMs: report.scan.lastScanMs,
        partial: report.scan.partial,
      },

      warning: scanStats.resolutionError || null,
      error: null,
    };
    lastReportMessage = cached;
    return { ...cached, requestId: requestId || null };
  }

  function clearTimers(): void {
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

  async function teardown(): Promise<void> {
    clearTimers();
    if (startPromise) await startPromise.catch(() => {});

    clearTimers();
    startPromise = null;
    scanner = null;
    pricing = null;
    lastSessionsMessage = null;
    lastSessionsSignature = null;
    lastReportMessage = null;
  }

  function restartIfConfigChanged(): void {
    if (usageCfgKey(config) === lastKey) return;
    lastKey = usageCfgKey(config);
    restartChain = restartChain.then(async () => {
      if (stopped) return;
      await teardown();
      if (!startRequested) return;
      await start();
    }).catch((error: unknown) => warn(`restart failed: ${errorMessage(error)}`));
  }

  async function stop(): Promise<void> {
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
    sessionTotals,
    getCachedReport: () => lastReportMessage,
    requestReport,
    ingestStatusline,
    getPlanLimitsMessage,
  };
}

export {
  DEFAULT_USAGE_CONFIG,
  NUDGE_DEBOUNCE_MS,
  PARTIAL_CONTINUE_MS,
  RTK_SAVINGS_TTL_MS,
  USAGE_BUDGET_KEYS,
  USAGE_COST_MODES,
  USAGE_INTEGER_RANGES,
  USAGE_VENDOR_KEYS,
  budgetAlertText,
  createUsageWiring,
  resolveUsageConfig,
  usageCfgKey,
  usageShouldStart,
};
export type { UsageLaneConfig, UsageWiringOptions };
