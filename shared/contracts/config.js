'use strict';

const path = require('node:path');
const { z } = require('zod');
const ranges = require('../settings-ranges');
const { USAGE_COST_MODES, USAGE_VENDOR_KEYS, USAGE_BUDGET_KEYS } = require('../usage-config');

/** @typedef {{ min: number, max?: number, exclusiveMin?: boolean, label?: string }} NumberRange */
const optionalBoolean = (field) => z.boolean({ error: `${field} must be a boolean` }).optional();
const optionalString = (field, trim = false) => {
  const schema = z.string({ error: `${field} must be a string` });
  return (trim ? schema.transform((value) => value.trim()) : schema).optional();
};
const numberRangeLabel = (range) => {
  if (range.label) return range.label;
  if (range.max != null) return `between ${range.min} and ${range.max}`;
  if (range.exclusiveMin) return `greater than ${range.min}`;
  return `at least ${range.min}`;
};
/** @param {NumberRange} range */
const optionalNumber = (field, range = ranges.POSITIVE_NUMBER_RANGE) => z.number({ error: `${field} must be ${numberRangeLabel(range)}` })
  .finite()
  .refine((value) => !range.exclusiveMin || value > range.min, { message: `${field} must be ${numberRangeLabel(range)}` })
  .refine((value) => range.exclusiveMin || value >= range.min, { message: `${field} must be ${numberRangeLabel(range)}` })
  .refine((value) => range.max == null || value <= range.max, { message: `${field} must be ${numberRangeLabel(range)}` })
  .optional();
const optionalInteger = (field, range) => z.number({ error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .int({ error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .min(range.min, { error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .max(range.max, { error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .optional();
const optionalObject = (field, shape) => z.object(shape, { error: `${field} must be an object` }).nullable().optional();
const optionalLooseObject = (field) => z.object({}, { error: `${field} must be an object` }).passthrough().nullable().optional();

const PrReviewSettings = optionalObject('prReview', {
  enabled: optionalBoolean('prReview.enabled'),
  projects: z.array(z.string({ error: 'prReview.projects must be an array of strings' }), { error: 'prReview.projects must be an array of strings' }).optional(),
  mergeMethod: z.enum(['rebase', 'squash', 'merge'], { error: 'prReview.mergeMethod must be one of rebase, squash, merge' }).optional(),
  intervalMinutes: optionalNumber('prReview.intervalMinutes', ranges.PR_REVIEW_INTERVAL_RANGE),
  maxConcurrentReviews: optionalNumber('prReview.maxConcurrentReviews', ranges.PR_REVIEW_MAX_CONCURRENT_RANGE),
  reviewTimeoutSeconds: optionalNumber('prReview.reviewTimeoutSeconds', ranges.PR_REVIEW_TIMEOUT_RANGE),
});

const BranchGcSettings = optionalObject('branchGc', {
  enabled: optionalBoolean('branchGc.enabled'),
  staleDays: optionalNumber('branchGc.staleDays', ranges.BRANCH_GC_STALE_DAYS_RANGE),
  intervalMs: optionalNumber('branchGc.intervalMs', ranges.BRANCH_GC_INTERVAL_MS_RANGE),
});

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
  packsAutoRebuild: optionalBoolean('packsAutoRebuild'),
  integrationBranch: optionalString('integrationBranch'),
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
  memory: MillSettings,
  ingest: MillSettings,
};

const BrowserConfig = z.object(BROWSER_CONFIG_SHAPE);
const ConfigUpdate = z.object({
  ...BROWSER_CONFIG_SHAPE,
  autoRecoverSeconds: z.number({ error: 'autoRecoverSeconds must be a positive number' }).finite().positive({ error: 'autoRecoverSeconds must be a positive number' }).optional(),
  inputGraceSeconds: z.number({ error: 'inputGraceSeconds must be a positive number' }).finite().positive({ error: 'inputGraceSeconds must be a positive number' }).optional(),
  promptDetectionMs: z.number({ error: 'promptDetectionMs must be a positive number' }).finite().positive({ error: 'promptDetectionMs must be a positive number' }).optional(),
  notifyDebounceMs: z.number({ error: 'notifyDebounceMs must be a positive number' }).finite().positive({ error: 'notifyDebounceMs must be a positive number' }).optional(),
  phoneEscalationMs: z.number({ error: 'phoneEscalationMs must be a positive number' }).finite().positive({ error: 'phoneEscalationMs must be a positive number' }).optional(),
  replayBufferKB: optionalNumber('replayBufferKB', ranges.REPLAY_BUFFER_KB_RANGE),
  worktreeAutoRebase: optionalBoolean('worktreeAutoRebase'),
  worktreeRerere: optionalBoolean('worktreeRerere'),
}).omit({ port: true, worktreeShare: true }).strict();
const ProjectConfig = z.object({
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
  memory: optionalLooseObject('memory'),
  ingest: optionalLooseObject('ingest'),
};
const Config = z.object({
  ...FILE_CONFIG_SHAPE,
  detectScheduledWakeups: optionalBoolean('detectScheduledWakeups'),
  worktreeAutoRebase: optionalBoolean('worktreeAutoRebase'),
  worktreeRerere: optionalBoolean('worktreeRerere'),
  postTurnChecks: z.record(z.string(), z.unknown()).optional(),
  remote: z.object({
    enabled: z.boolean().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    publicHost: z.string().optional(),
    allowedOrigins: z.array(z.string()).optional(),
  }).passthrough().optional(),
  projects: z.array(ProjectConfig),
}).passthrough();

const BROWSER_CONFIG_KEYS = Object.freeze(Object.keys(BROWSER_CONFIG_SHAPE));
const CONFIG_BLOCK_KEYS = Object.freeze([
  'prReview', 'branchGc', 'visions', 'posthog', 'usage', 'telegram', 'packDistiller', 'memory', 'ingest',
]);
const CONFIG_SCALAR_KEYS = Object.freeze(Object.keys(BROWSER_CONFIG_SHAPE).filter((key) => {
  if (CONFIG_BLOCK_KEYS.includes(key)) return false;
  return key !== 'port' && key !== 'repoRoots' && key !== 'worktreeShare';
}));
const RUNTIME_CONFIG_SCALAR_KEYS = Object.freeze([...CONFIG_SCALAR_KEYS, 'worktreeAutoRebase', 'worktreeRerere']);
const HIDDEN_CONFIG_KEYS = Object.freeze([
  'detectScheduledWakeups',
  'worktreeAutoRebase',
  'worktreeRerere',
  'postTurnChecks',
  'remote',
  'projects',
]);

function configIssueMessage(error) {
  return error.issues[0]?.message || 'settings are invalid';
}

/** @typedef {import('zod').infer<typeof Config>} Config */
/** @typedef {import('zod').infer<typeof BrowserConfig>} BrowserConfig */
/** @typedef {import('zod').infer<typeof ConfigUpdate>} ConfigUpdate */

module.exports = {
  BROWSER_CONFIG_KEYS,
  CONFIG_BLOCK_KEYS,
  CONFIG_SCALAR_KEYS,
  RUNTIME_CONFIG_SCALAR_KEYS,
  HIDDEN_CONFIG_KEYS,
  BrowserConfig,
  Config,
  ConfigUpdate,
  ProjectConfig,
  configIssueMessage,
};
