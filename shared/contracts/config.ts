import path from 'node:path';
import { z } from 'zod';
import * as ranges from '../settings-ranges.ts';
import type { SettingsRange } from '../settings-ranges.ts';
import { USAGE_COST_MODES, USAGE_VENDOR_KEYS, USAGE_BUDGET_KEYS } from '../usage-config.ts';

const optionalBoolean = (field: string) => z.boolean({ error: `${field} must be a boolean` }).optional();
const optionalString = (field: string, trim = false) => {
  const schema = z.string({ error: `${field} must be a string` });
  return (trim ? schema.transform((value) => value.trim()) : schema).optional();
};
const numberRangeLabel = (range: SettingsRange) => {
  if (range.label) return range.label;
  if (range.max != null) return `between ${range.min} and ${range.max}`;
  if (range.exclusiveMin) return `greater than ${range.min}`;
  return `at least ${range.min}`;
};
const optionalNumber = (field: string, range: SettingsRange = ranges.POSITIVE_NUMBER_RANGE) => z.number({ error: `${field} must be ${numberRangeLabel(range)}` })
  .finite()
  .refine((value) => !range.exclusiveMin || value > range.min, { message: `${field} must be ${numberRangeLabel(range)}` })
  .refine((value) => range.exclusiveMin || value >= range.min, { message: `${field} must be ${numberRangeLabel(range)}` })
  .refine((value) => range.max == null || value <= range.max, { message: `${field} must be ${numberRangeLabel(range)}` })
  .optional();
const optionalInteger = (field: string, range: { min: number; max: number }) => z.number({ error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .int({ error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .min(range.min, { error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .max(range.max, { error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .optional();
const optionalObject = (field: string, shape: z.ZodRawShape) => z.object(shape, { error: `${field} must be an object` }).nullable().optional();
const optionalLooseObject = (field: string) => z.object({}, { error: `${field} must be an object` }).passthrough().nullable().optional();

const PrReviewSettings = optionalObject('prReview', {
  enabled: optionalBoolean('prReview.enabled'),
  projects: z.array(z.string({ error: 'prReview.projects must be an array of strings' }), { error: 'prReview.projects must be an array of strings' }).optional(),
  mergeMethod: z.enum(['rebase', 'squash', 'merge'], { error: 'prReview.mergeMethod must be one of rebase, squash, merge' }).optional(),
  intervalMinutes: optionalNumber('prReview.intervalMinutes', ranges.PR_REVIEW_INTERVAL_RANGE),
  maxConcurrentReviews: optionalNumber('prReview.maxConcurrentReviews', ranges.PR_REVIEW_MAX_CONCURRENT_RANGE),
  reviewTimeoutSeconds: optionalNumber('prReview.reviewTimeoutSeconds', ranges.PR_REVIEW_TIMEOUT_RANGE),
});

const BRANCH_GC_SETTINGS_SHAPE = {
  enabled: optionalBoolean('branchGc.enabled'),
  prefixes: z.array(
    z.string({ error: 'branchGc.prefixes must be an array of strings' })
      .min(1, { error: 'branchGc.prefixes entries must be non-empty strings' }),
    { error: 'branchGc.prefixes must be an array of strings' },
  ).optional(),
  dryRun: optionalBoolean('branchGc.dryRun'),
  staleDays: optionalNumber('branchGc.staleDays', ranges.BRANCH_GC_STALE_DAYS_RANGE),
  intervalMs: optionalNumber('branchGc.intervalMs', ranges.BRANCH_GC_INTERVAL_MS_RANGE),
};
export const BranchGcFileSettings = z.object(BRANCH_GC_SETTINGS_SHAPE, { error: 'branchGc must be an object' });
const BranchGcSettings = optionalObject('branchGc', BRANCH_GC_SETTINGS_SHAPE);
const BranchGcControlSettings = BranchGcFileSettings.omit({ prefixes: true, dryRun: true }).nullable().optional();
export const BRANCH_GC_CONTROL_BOOLEAN_KEYS = Object.freeze(['enabled']);
export const BRANCH_GC_CONTROL_NUMERIC_KEYS = Object.freeze(['staleDays', 'intervalMs']);

const VisionsSettings = optionalObject('visions', {
  enabled: optionalBoolean('visions.enabled'),
  autoFix: optionalBoolean('visions.autoFix'),
  projects: z.array(z.string({ error: 'visions.projects must be an array of strings' }), { error: 'visions.projects must be an array of strings' }).optional(),
  dispatch: optionalObject('visions.dispatch', {
    enabled: optionalBoolean('visions.dispatch.enabled'),
    model: optionalString('visions.dispatch.model', true),
    quietMs: optionalNumber('visions.dispatch.quietMs', ranges.VISIONS_QUIET_MS_RANGE),
    cooldownMs: optionalNumber('visions.dispatch.cooldownMs', ranges.VISIONS_COOLDOWN_MS_RANGE),
    maxPerHour: optionalNumber('visions.dispatch.maxPerHour', ranges.VISIONS_MAX_PER_HOUR_RANGE),
    activityMaxPerHour: optionalNumber('visions.dispatch.activityMaxPerHour', ranges.VISIONS_ACTIVITY_MAX_PER_HOUR_RANGE),
    dispatchTimeoutSeconds: optionalNumber('visions.dispatch.dispatchTimeoutSeconds', ranges.VISIONS_DISPATCH_TIMEOUT_RANGE),
  }),
  intent: optionalObject('visions.intent', {
    threadTtlMs: optionalNumber('visions.intent.threadTtlMs', ranges.VISIONS_INTENT_THREAD_TTL_MS_RANGE),
  }),
});

const posthogNumberRanges = {
  intervalMinutes: ranges.POSTHOG_INTERVAL_RANGE,
  maxConcurrentInvestigations: ranges.POSTHOG_MAX_CONCURRENT_RANGE,
  investigationTimeoutSeconds: ranges.POSTHOG_INVESTIGATION_TIMEOUT_RANGE,
  fixTimeoutSeconds: ranges.POSTHOG_FIX_TIMEOUT_RANGE,
  minUsersToInvestigate: ranges.POSTHOG_MIN_USERS_RANGE,
  userEscalationThreshold: ranges.POSTHOG_ESCALATION_RANGE,
  recurrenceWindowDays: ranges.POSTHOG_RECURRENCE_WINDOW_RANGE,
  transientRecurrenceLimit: ranges.POSTHOG_TRANSIENT_RECURRENCE_RANGE,
  trafficSpikeMultiplier: ranges.POSTHOG_TRAFFIC_MULTIPLIER_RANGE,
  trafficSpikeMinUsers: ranges.POSTHOG_TRAFFIC_MIN_USERS_RANGE,
  trafficSpikeCooldownMinutes: ranges.POSTHOG_TRAFFIC_COOLDOWN_RANGE,
  trafficSpikeBaselineDays: ranges.POSTHOG_TRAFFIC_BASELINE_RANGE,
};

const PosthogSettings = optionalObject('posthog', {
  enabled: optionalBoolean('posthog.enabled'),
  recurrenceDedupe: optionalBoolean('posthog.recurrenceDedupe'),
  trafficSpikeEnabled: optionalBoolean('posthog.trafficSpikeEnabled'),
  autoFix: optionalBoolean('posthog.autoFix'),
  host: optionalString('posthog.host', true).refine((value) => value == null || !value || /^https?:\/\//i.test(value), { message: 'posthog.host must be an http(s) URL' }),
  apiKey: optionalString('posthog.apiKey', true),
  repoPath: optionalString('posthog.repoPath', true),
  projects: z.union([
    z.literal('all'),
    z.array(z.number({ error: 'posthog.projects must be "all" or an array of positive integer project ids' }).int({ error: 'posthog.projects must be "all" or an array of positive integer project ids' }).positive({ error: 'posthog.projects must be "all" or an array of positive integer project ids' }), { error: 'posthog.projects must be "all" or an array of positive integer project ids' }),
  ], { error: 'posthog.projects must be "all" or an array of positive integer project ids' }).optional(),
  projectMap: z.record(z.string(), z.unknown(), { error: 'posthog.projectMap must be an object' }).optional(),
  ...Object.fromEntries(Object.entries(posthogNumberRanges).map(([key, range]) => [key, optionalNumber(`posthog.${key}`, range)])),
});

const usageCostModeMessage = `usage.costMode must be one of ${USAGE_COST_MODES.join(', ')}`;
const usageVendorShape = Object.fromEntries(
  USAGE_VENDOR_KEYS.map((key) => [key, optionalBoolean(`usage.vendors.${key}`)]),
);
const usageBudgetShape = Object.fromEntries(
  USAGE_BUDGET_KEYS.map((key) => [
    key,
    z.number({ error: `usage.budget.${key} must be a positive number or null` })
      .positive({ error: `usage.budget.${key} must be a positive number or null` })
      .nullable()
      .optional(),
  ]),
);

const UsageSettings = optionalObject('usage', {
  enabled: optionalBoolean('usage.enabled'),
  fetchPricing: optionalBoolean('usage.fetchPricing'),
  planLimits: optionalBoolean('usage.planLimits'),
  rtkSavings: optionalBoolean('usage.rtkSavings'),
  scanIntervalMinutes: optionalInteger('usage.scanIntervalMinutes', ranges.USAGE_INTEGER_RANGES.scanIntervalMinutes),
  retainDays: optionalInteger('usage.retainDays', ranges.USAGE_INTEGER_RANGES.retainDays),
  warehouseRetainDays: optionalInteger('usage.warehouseRetainDays', ranges.USAGE_INTEGER_RANGES.warehouseRetainDays),
  sessionBlockHours: optionalInteger('usage.sessionBlockHours', ranges.USAGE_INTEGER_RANGES.sessionBlockHours),
  costMode: z.enum(USAGE_COST_MODES, { error: usageCostModeMessage }).optional(),
  vendors: optionalObject('usage.vendors', usageVendorShape),
  budget: optionalObject('usage.budget', usageBudgetShape),
  extraProjectsDirs: z.array(z.string({ error: 'usage.extraProjectsDirs must be an array of absolute paths' }), { error: 'usage.extraProjectsDirs must be an array of absolute paths' })
    .transform((directories) => directories.map((directory) => directory.trim()))
    .refine((directories) => directories.every((directory) => directory && path.isAbsolute(directory)), { message: 'usage.extraProjectsDirs entries must be absolute paths' })
    .optional(),
});

const TelegramSettings = optionalObject('telegram', {
  botToken: optionalString('telegram.botToken', true),
  chatId: optionalString('telegram.chatId', true),
});

const MillSettings = z.object({
  enabled: optionalBoolean('mill.enabled'),
}, { error: 'mill must be an object' }).passthrough().optional();

const MillMetricsSettings = z.object({
  retainDays: optionalInteger('millMetrics.retainDays', ranges.MILL_METRICS_RETAIN_DAY_RANGE),
}, { error: 'millMetrics must be an object' }).optional();

const BROWSER_CONFIG_SHAPE = {
  port: z.number().int().min(0).max(65535).optional(),
  autoRecoverSeconds: z.number().finite().nonnegative().optional(),
  inputGraceSeconds: z.number().finite().nonnegative().optional(),
  promptDetectionMs: z.number().finite().nonnegative().optional(),
  notifyDebounceMs: z.number().finite().nonnegative().optional(),
  phoneEscalationMs: z.number().finite().nonnegative().optional(),
  replayBufferKB: optionalNumber('replayBufferKB', { ...ranges.REPLAY_BUFFER_KB_RANGE, min: 0 }),
  cursorBlink: optionalBoolean('cursorBlink'),
  debugMode: optionalBoolean('debugMode'),
  detectBackgroundAgents: optionalBoolean('detectBackgroundAgents'),
  recordSignals: optionalBoolean('recordSignals'),
  antiSlopPrompt: optionalBoolean('antiSlopPrompt'),
  rtk: optionalBoolean('rtk'),
  checkForUpdates: optionalBoolean('checkForUpdates'),
  autoResume: optionalBoolean('autoResume'),
  telegramNotifications: optionalBoolean('telegramNotifications'),
  millEnabled: optionalBoolean('millEnabled'),
  integrationBranch: optionalString('integrationBranch').nullable(),
  worktreeRoot: optionalString('worktreeRoot'),
  worktreeShare: z.array(z.string()).optional(),
  repoRoots: z.array(z.string()).optional(),
  prReview: PrReviewSettings,
  branchGc: BranchGcSettings,
  visions: VisionsSettings,
  posthog: PosthogSettings,
  usage: UsageSettings,
  telegram: TelegramSettings,
  packDistiller: MillSettings,
  millMetrics: MillMetricsSettings,
  memory: MillSettings,
  ingest: MillSettings,
};

export const BrowserConfig = z.object(BROWSER_CONFIG_SHAPE);
export const ConfigUpdate = z.object({
  ...BROWSER_CONFIG_SHAPE,
  autoRecoverSeconds: z.number({ error: 'autoRecoverSeconds must be a positive number' }).finite().positive({ error: 'autoRecoverSeconds must be a positive number' }).optional(),
  inputGraceSeconds: z.number({ error: 'inputGraceSeconds must be a positive number' }).finite().positive({ error: 'inputGraceSeconds must be a positive number' }).optional(),
  promptDetectionMs: z.number({ error: 'promptDetectionMs must be a positive number' }).finite().positive({ error: 'promptDetectionMs must be a positive number' }).optional(),
  notifyDebounceMs: z.number({ error: 'notifyDebounceMs must be a positive number' }).finite().positive({ error: 'notifyDebounceMs must be a positive number' }).optional(),
  phoneEscalationMs: z.number({ error: 'phoneEscalationMs must be a positive number' }).finite().positive({ error: 'phoneEscalationMs must be a positive number' }).optional(),
  replayBufferKB: optionalNumber('replayBufferKB', ranges.REPLAY_BUFFER_KB_RANGE),
  branchGc: BranchGcControlSettings,
  worktreeAutoRebase: optionalBoolean('worktreeAutoRebase'),
  worktreeSyncOnStart: optionalBoolean('worktreeSyncOnStart'),
  worktreeRerere: optionalBoolean('worktreeRerere'),
}).omit({ port: true, worktreeShare: true }).strict();
export const ProjectConfig = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  path: z.string(),
  agent: z.enum(['claude-code', 'codex', 'grok']).optional(),
  codexBypassHookTrust: z.boolean().optional(),
}).passthrough();
const FILE_CONFIG_SHAPE = {
  ...BROWSER_CONFIG_SHAPE,
  prReview: optionalLooseObject('prReview'),
  branchGc: optionalLooseObject('branchGc'),
  visions: optionalLooseObject('visions'),
  posthog: optionalLooseObject('posthog'),
  usage: optionalLooseObject('usage'),
  telegram: optionalLooseObject('telegram'),
  packDistiller: optionalLooseObject('packDistiller'),
  millMetrics: optionalLooseObject('millMetrics'),
  memory: optionalLooseObject('memory'),
  ingest: optionalLooseObject('ingest'),
};
export const Config = z.object({
  ...FILE_CONFIG_SHAPE,
  detectScheduledWakeups: optionalBoolean('detectScheduledWakeups'),
  worktreeAutoRebase: optionalBoolean('worktreeAutoRebase'),
  worktreeSyncOnStart: optionalBoolean('worktreeSyncOnStart'),
  worktreeRerere: optionalBoolean('worktreeRerere'),
  postTurnChecks: z.record(z.string(), z.unknown()).optional(),
  hooks: z.unknown().optional(),
  remote: z.object({
    enabled: z.boolean().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    publicHost: z.string().optional(),
    allowedOrigins: z.array(z.string()).optional(),
  }).passthrough().optional(),
  projects: z.array(ProjectConfig),
}).passthrough();

export const BROWSER_CONFIG_KEYS = Object.freeze(Object.keys(BROWSER_CONFIG_SHAPE));
export const CONFIG_BLOCK_KEYS = Object.freeze([
  'prReview', 'branchGc', 'visions', 'posthog', 'usage', 'telegram', 'packDistiller', 'millMetrics', 'memory', 'ingest',
]);
export const CONFIG_SCALAR_KEYS = Object.freeze(Object.keys(BROWSER_CONFIG_SHAPE).filter((key) => {
  if (CONFIG_BLOCK_KEYS.includes(key)) return false;
  return key !== 'port' && key !== 'repoRoots' && key !== 'worktreeShare';
}));
export const RUNTIME_CONFIG_SCALAR_KEYS = Object.freeze([
  ...CONFIG_SCALAR_KEYS,
  'worktreeAutoRebase',
  'worktreeSyncOnStart',
  'worktreeRerere',
]);
export const HIDDEN_CONFIG_KEYS = Object.freeze([
  'detectScheduledWakeups',
  'worktreeAutoRebase',
  'worktreeSyncOnStart',
  'worktreeRerere',
  'postTurnChecks',
  'hooks',
  'remote',
  'projects',
]);

export function configIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message || 'settings are invalid';
}

export type BranchGcFileSettings = z.infer<typeof BranchGcFileSettings>;
export type Config = z.infer<typeof Config>;
export type BrowserConfig = z.infer<typeof BrowserConfig>;
export type ConfigUpdate = z.infer<typeof ConfigUpdate>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;
