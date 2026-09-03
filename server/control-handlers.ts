import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessage, RUNTIME_CONFIG_SCALAR_KEYS, ConfigUpdate, configIssueMessage,
} from '../shared/contracts/index.ts';
import { STATES } from '../shared/states.ts';
import { claudeProjectsDir, listRepoConversations } from '../session/core/conversation-history.ts';
import type { Session } from '../session/sessions.ts';
import type { ControlSocket } from './backend-websockets.ts';
import type { ConfigStore, GlissaConfig, ProjectEntry } from './config-store.ts';
import type { ControlMessageRecord, ReplayLog } from './control-replay-core.ts';
import { normalizeClientTrust } from './core/request-trust.ts';
import {
  INGEST_SPEC, MEMORY_SPEC, MILL_METRICS_SPEC, PACK_DISTILLER_SPEC, mergeMillBlock, validateMillBlock,
} from './core/settings-mill-core.ts';
import { readPosthogReport } from './posthog-report.ts';
import * as posthogCore from './core/posthog-core.ts';
import { buildSettingsPayload as buildSettingsPayloadFrom } from './settings-payload.ts';
import { RESUME_ID_RE } from '../session/core/auto-resume.ts';
import { execFile } from './child-process-safe.ts';
import { DEFAULT_AGENT_ID, isKnownAgentId, listAgentIds, getAdapter, commandFor } from '../session/adapters/index.ts';
import { HOOK_EVENT_CATALOG, ID_RE as HOOK_ID_RE, MAX_TIMEOUT_SEC as HOOK_MAX_TIMEOUT_SEC, normalizeHook, rawStoredHooks, readStoredHooks, removeHook, upsertHook } from '../session/core/user-hooks-core.ts';
import { describeBuiltinHooks } from '../detection/settings-injector.ts';
import { getRtkPath } from './rtk-resolver.ts';
import {
  BRANCH_GC_INTERVAL_MS_RANGE,
  BRANCH_GC_STALE_DAYS_RANGE,
  POSTHOG_ESCALATION_RANGE,
  POSTHOG_FIX_TIMEOUT_RANGE,
  POSTHOG_INTERVAL_RANGE,
  POSTHOG_INVESTIGATION_TIMEOUT_RANGE,
  POSTHOG_MAX_CONCURRENT_RANGE,
  POSTHOG_MIN_USERS_RANGE,
  POSTHOG_RECURRENCE_WINDOW_RANGE,
  POSTHOG_TRAFFIC_BASELINE_RANGE,
  POSTHOG_TRAFFIC_COOLDOWN_RANGE,
  POSTHOG_TRAFFIC_MIN_USERS_RANGE,
  POSTHOG_TRAFFIC_MULTIPLIER_RANGE,
  POSTHOG_TRANSIENT_RECURRENCE_RANGE,
  PR_REVIEW_INTERVAL_RANGE,
  PR_REVIEW_MAX_CONCURRENT_RANGE,
  PR_REVIEW_TIMEOUT_RANGE,
  VISIONS_ACTIVITY_MAX_PER_HOUR_RANGE,
  VISIONS_COOLDOWN_MS_RANGE,
  VISIONS_DISPATCH_TIMEOUT_RANGE,
  VISIONS_INTENT_THREAD_TTL_MS_RANGE,
  VISIONS_MAX_PER_HOUR_RANGE,
  VISIONS_QUIET_MS_RANGE,
  USAGE_INTEGER_RANGES,
} from '../shared/settings-ranges.ts';
import { USAGE_VENDOR_KEYS, USAGE_BUDGET_KEYS } from '../shared/usage-config.ts';

interface ControlRequest {
  type: string;
  id?: string;
  requestId?: string | null;
  name?: string;
  newName?: string;
  path?: string;
  agent?: string;
  order?: string[];
  conversationId?: string;
  dangerouslySkipPermissions?: boolean;
  settings?: Record<string, unknown>;
  issueId?: string | number;
  projectId?: string | number;
  action?: string;
  days?: unknown;
  force?: unknown;
  fresh?: unknown;
  focused?: boolean;
  pack?: string;
  deliver?: boolean;
  hook?: Record<string, unknown>;
  [key: string]: unknown;
}

type ControlHandler = (msg: ControlRequest, ws: ControlSocket) => unknown;

interface PosthogLaneStatus {
  projects?: unknown;
  [key: string]: unknown;
}

interface MillControl {
  requestReport(msg: ControlRequest, send: (payload: unknown) => void): Promise<void>;
  getCachedReport(): unknown;
}

interface ControlHandlerDeps {
  sessions: Map<string, Session>;

  makeSession?: (project: ProjectEntry, config: GlissaConfig) => Session;
  wireSessionEvents?: (session: Session) => void;
  config: GlissaConfig;
  configStore: ConfigStore;
  broadcastControl: (message: ControlMessageRecord) => void;
  generateProjectId: () => string;
  applyConfigReload: (config: GlissaConfig) => void;
  applySettingsReload: (config: GlissaConfig) => void;
  requestShutdown?: (() => unknown) | null;
  requestRestart?: (() => unknown) | null;
  handleClientFocus?: ((socket: ControlSocket, focused: boolean) => void) | null;
  buildHealthSnapshot?: (() => unknown) | null;
  getUpdateStatus?: (() => { updateAvailable?: boolean } | null) | null;
  getPosthogStatus?: (() => PosthogLaneStatus | null) | null;
  posthogReportsDir?: string | null;
  posthogSetIssueStatus?: ((args: { projectId: string; issueId: string; action: string }) => Promise<Record<string, unknown>>) | null;
  posthogArchiveInvestigation?: ((args: { id: string }) => Promise<Record<string, unknown>>) | null;
  getPrStatus?: (() => unknown) | null;
  getPackVersions?: () => Record<string, string | null>;
  serverBuild?: () => string | null;
  getUsageSessions?: (() => unknown) | null;
  getUsageReport?: (() => unknown) | null;
  requestUsageReport?: ((args: { days?: number; force?: boolean; requestId?: string | null }) => Promise<unknown>) | null;
  getPlanLimits?: (() => unknown) | null;
  millReport?: MillControl | null;
  controlReplayLog?: ReplayLog | null;
  getRtkInstallStatus?: () => Record<string, unknown> | null;
  resolveRtkPath?: () => string | null;
  conversationFs?: typeof fs;
  conversationGit?: (args: string[], cwd: string) => Promise<string>;
  conversationProjectsDir?: string;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scanRepoRoots(roots: string[] | undefined): { root: string; projects: { name: string; path: string }[] }[] {
  const results: { root: string; projects: { name: string; path: string }[] }[] = [];
  if (!roots) return results;
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) {
        results.push({ root, projects: [] });
        continue;
      }
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const projects = entries
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map(d => ({ name: d.name, path: path.join(root, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      results.push({ root, projects });
    } catch (err) {
      console.warn(`[settings] Failed to scan root: ${root}: ${errorCode(err) || errorMessage(err)}`);
      results.push({ root, projects: [] });
    }
  }
  return results;
}

const PR_REVIEW_BOOLEAN_KEYS = Object.freeze(['enabled']);
const PR_REVIEW_VALUE_KEYS = Object.freeze(['projects', 'mergeMethod']);
const PR_REVIEW_NUMERIC_KEYS = Object.freeze(['intervalMinutes', 'maxConcurrentReviews', 'reviewTimeoutSeconds']);
const PR_REVIEW_NUMERIC_RANGES = Object.freeze({
  intervalMinutes: PR_REVIEW_INTERVAL_RANGE,
  maxConcurrentReviews: PR_REVIEW_MAX_CONCURRENT_RANGE,
  reviewTimeoutSeconds: PR_REVIEW_TIMEOUT_RANGE,
});
const BRANCH_GC_BOOLEAN_KEYS = Object.freeze(['enabled']);
const BRANCH_GC_NUMERIC_KEYS = Object.freeze(['staleDays', 'intervalMs']);
const BRANCH_GC_NUMERIC_RANGES = Object.freeze({
  staleDays: BRANCH_GC_STALE_DAYS_RANGE,
  intervalMs: BRANCH_GC_INTERVAL_MS_RANGE,
});
const VISIONS_BOOLEAN_KEYS = Object.freeze(['enabled', 'autoFix']);
const VISIONS_VALUE_KEYS = Object.freeze(['projects']);
const VISIONS_DISPATCH_BOOLEAN_KEYS = Object.freeze(['enabled']);
const VISIONS_DISPATCH_STRING_KEYS = Object.freeze(['model']);
const VISIONS_DISPATCH_NUMERIC_KEYS = Object.freeze(['quietMs', 'cooldownMs', 'maxPerHour', 'activityMaxPerHour', 'dispatchTimeoutSeconds']);
const VISIONS_DISPATCH_NUMERIC_RANGES = Object.freeze({
  quietMs: VISIONS_QUIET_MS_RANGE,
  cooldownMs: VISIONS_COOLDOWN_MS_RANGE,
  maxPerHour: VISIONS_MAX_PER_HOUR_RANGE,
  activityMaxPerHour: VISIONS_ACTIVITY_MAX_PER_HOUR_RANGE,
  dispatchTimeoutSeconds: VISIONS_DISPATCH_TIMEOUT_RANGE,
});
const VISIONS_INTENT_NUMERIC_KEYS = Object.freeze(['threadTtlMs']);
const VISIONS_INTENT_NUMERIC_RANGES = Object.freeze({ threadTtlMs: VISIONS_INTENT_THREAD_TTL_MS_RANGE });
const POSTHOG_NUMERIC_KEYS = Object.freeze([
  'intervalMinutes',
  'maxConcurrentInvestigations',
  'investigationTimeoutSeconds',
  'fixTimeoutSeconds',
  'minUsersToInvestigate',
  'userEscalationThreshold',
  'recurrenceWindowDays',
  'transientRecurrenceLimit',
  'trafficSpikeMultiplier',
  'trafficSpikeMinUsers',
  'trafficSpikeCooldownMinutes',
  'trafficSpikeBaselineDays',
]);

const POSTHOG_NUMERIC_RANGES = Object.freeze({
  intervalMinutes: POSTHOG_INTERVAL_RANGE,
  maxConcurrentInvestigations: POSTHOG_MAX_CONCURRENT_RANGE,
  investigationTimeoutSeconds: POSTHOG_INVESTIGATION_TIMEOUT_RANGE,
  fixTimeoutSeconds: POSTHOG_FIX_TIMEOUT_RANGE,
  minUsersToInvestigate: POSTHOG_MIN_USERS_RANGE,
  userEscalationThreshold: POSTHOG_ESCALATION_RANGE,
  recurrenceWindowDays: POSTHOG_RECURRENCE_WINDOW_RANGE,
  transientRecurrenceLimit: POSTHOG_TRANSIENT_RECURRENCE_RANGE,
  trafficSpikeMultiplier: POSTHOG_TRAFFIC_MULTIPLIER_RANGE,
  trafficSpikeMinUsers: POSTHOG_TRAFFIC_MIN_USERS_RANGE,
  trafficSpikeCooldownMinutes: POSTHOG_TRAFFIC_COOLDOWN_RANGE,
  trafficSpikeBaselineDays: POSTHOG_TRAFFIC_BASELINE_RANGE,
});

const POSTHOG_BOOLEAN_KEYS = Object.freeze(['enabled', 'recurrenceDedupe', 'trafficSpikeEnabled', 'autoFix']);
const POSTHOG_STRING_KEYS = Object.freeze(['host', 'apiKey', 'repoPath']);
const POSTHOG_VALUE_KEYS = Object.freeze(['projects', 'projectMap']);

const USAGE_BOOLEAN_KEYS = Object.freeze(['enabled', 'fetchPricing', 'planLimits', 'rtkSavings']);
const USAGE_VALUE_KEYS = Object.freeze(['costMode', 'extraProjectsDirs']);
const TELEGRAM_STRING_KEYS = Object.freeze(['botToken', 'chatId']);

function mergeSettingsBlockOverStored(stored: unknown, incoming: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  return merged;
}
const DASHBOARD_SETTING_PATHS = Object.freeze([
  ...PR_REVIEW_BOOLEAN_KEYS.map((key) => `prReview.${key}`),
  ...PR_REVIEW_VALUE_KEYS.map((key) => `prReview.${key}`),
  ...PR_REVIEW_NUMERIC_KEYS.map((key) => `prReview.${key}`),
  ...BRANCH_GC_BOOLEAN_KEYS.map((key) => `branchGc.${key}`),
  ...BRANCH_GC_NUMERIC_KEYS.map((key) => `branchGc.${key}`),
  ...VISIONS_BOOLEAN_KEYS.map((key) => `visions.${key}`),
  ...VISIONS_VALUE_KEYS.map((key) => `visions.${key}`),
  ...VISIONS_DISPATCH_BOOLEAN_KEYS.map((key) => `visions.dispatch.${key}`),
  ...VISIONS_DISPATCH_STRING_KEYS.map((key) => `visions.dispatch.${key}`),
  ...VISIONS_DISPATCH_NUMERIC_KEYS.map((key) => `visions.dispatch.${key}`),
  ...VISIONS_INTENT_NUMERIC_KEYS.map((key) => `visions.intent.${key}`),
  ...POSTHOG_BOOLEAN_KEYS.map((key) => `posthog.${key}`),
  ...POSTHOG_STRING_KEYS.map((key) => `posthog.${key}`),
  ...POSTHOG_VALUE_KEYS.map((key) => `posthog.${key}`),
  ...POSTHOG_NUMERIC_KEYS.map((key) => `posthog.${key}`),
  ...USAGE_BOOLEAN_KEYS.map((key) => `usage.${key}`),
  ...Object.keys(USAGE_INTEGER_RANGES).map((key) => `usage.${key}`),
  ...USAGE_VALUE_KEYS.map((key) => `usage.${key}`),
  ...USAGE_VENDOR_KEYS.map((key) => `usage.vendors.${key}`),
  ...USAGE_BUDGET_KEYS.map((key) => `usage.budget.${key}`),
  ...TELEGRAM_STRING_KEYS.map((key) => `telegram.${key}`),
]);

const USAGE_REPORT_MAX_DAYS = 3650;
const execFileAsync = promisify(execFile);

async function runGitForConversationHistory(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  return stdout;
}

function sendError(ws: ControlSocket, message: string, { type = 'error', requestId }: { type?: string; requestId?: string | null } = {}): void {
  const payload = requestId !== undefined ? { type, requestId, message } : { type, message };
  ws.send(JSON.stringify(payload));
}

function requestValidationErrorReply(msg: Record<string, unknown> | null | undefined, message: string): Record<string, unknown> | null {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
  const builders: Record<string, () => Record<string, unknown>> = {
    'list-conversations': () => ({ type: 'conversations', requestId, id: typeof msg?.id === 'string' ? msg.id : null, conversations: [], error: message }),
    'resume-conversation': () => ({ type: 'resume-conversation-ack', id: typeof msg?.id === 'string' ? msg.id : undefined, ok: false, error: message }),
    'ping': () => ({ type: 'pong', requestId, error: message }),
    'get-settings': () => ({ type: 'settings-error', requestId, message }),
    'update-settings': () => ({ type: 'settings-error', requestId, message }),
    'scan-repo-roots': () => ({ type: 'repo-roots-scanned', requestId, directories: [], error: message }),
    'list-agents': () => ({ type: 'agents-listed', requestId, agents: [], error: message }),
    'get-posthog-report': () => ({ type: 'posthog-report', requestId, ok: false, found: false, issueId: null, error: message }),
    'posthog-open-session': () => ({ type: 'posthog-open-session-result', requestId, ok: false, error: message }),
    'posthog-issue-action': () => ({ type: 'posthog-issue-action-result', requestId, ok: false, error: message }),
    'posthog-archive-investigation': () => ({ type: 'posthog-archive-investigation-result', requestId, ok: false, error: message }),
    'request-usage-report': () => ({ type: 'usage-report', requestId, error: message }),
    'request-mill-report': () => ({ type: 'mill-report', requestId, error: message }),
    'request-hooks-report': () => ({ type: 'hooks-report', requestId, error: message }),
    'save-hook': () => ({ type: 'save-hook-result', requestId, ok: false, error: message }),
    'delete-hook': () => ({ type: 'delete-hook-result', requestId, ok: false, error: message }),
  };
  const requestType = typeof msg?.type === 'string' ? msg.type : '';
  if (Object.hasOwn(builders, requestType)) return builders[requestType]();
  const genericErrorRequests = new Set([
    'request-session-diff',
    'request-branch-sync',
    'resync-branch',
    'debug-state',
    'request-health-snapshot',
  ]);
  if (genericErrorRequests.has(requestType)) return { type: 'error', message };
  return null;
}

const MILL_SPECS = [MEMORY_SPEC, MILL_METRICS_SPEC, PACK_DISTILLER_SPEC, INGEST_SPEC];

function parseSinceParam(url: string | undefined): number | null {
  if (!url) return null;
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return null;
  const raw = new URLSearchParams(url.slice(qIndex + 1)).get('since');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function registerControlHandlers(controlWss: WebSocketServer, deps: ControlHandlerDeps) {
  const {
    sessions,
    config,
    configStore,
    broadcastControl,
    generateProjectId,
    applyConfigReload,
    applySettingsReload,
    requestShutdown,
    requestRestart,
    handleClientFocus,
    buildHealthSnapshot,
    getUpdateStatus,

    getPosthogStatus,
    posthogReportsDir = null,

    posthogSetIssueStatus = null,
    posthogArchiveInvestigation = null,

    getPrStatus,

    getPackVersions = () => ({}),

    serverBuild = () => null,

    getUsageSessions = null,
    getUsageReport = null,
    requestUsageReport = null,
    getPlanLimits = null,

    millReport = null,

    controlReplayLog = null,

    getRtkInstallStatus = (): Record<string, unknown> | null => null,

    resolveRtkPath = () => getRtkPath(),
    conversationFs = fs,
    conversationGit = runGitForConversationHistory,
    conversationProjectsDir = claudeProjectsDir(process.env, os.homedir()),
  } = deps;

  function buildSettingsPayload() {
    return buildSettingsPayloadFrom({ configStore, rtkInstallStatus: getRtkInstallStatus() });
  }

  function findSession(msg: ControlRequest): Session | null {
    if (msg.id && sessions.has(msg.id)) return sessions.get(msg.id) ?? null;
    return null;
  }

  const MERGE_REFUSAL_COPY: Record<string, string> = {
    'destroyed':         'session no longer exists',
    'no-worktree':       'no worktree to merge',
    'merge-in-progress': 'a merge is already in flight on this worktree',
  };

  function reportMergeRefusal(ws: ControlSocket, s: Session, r: { refused?: boolean; reason?: string | null } | null | undefined): void {
    if (!r || r.refused !== true) return;
    const detail = r.reason === 'not-continuable'
      ? `session state ${s.state} is not mergeable`
      : ((r.reason ? MERGE_REFUSAL_COPY[r.reason] : '') || r.reason);
    console.log(`[control] merge refused: id=${s.id} state=${s.state} reason=${r.reason}`);
    ws.send(JSON.stringify({ type: 'session-error', id: s.id, session: s.name, message: `Merge refused: ${detail}.` }));
  }

  function buildSnapshot() {
    const list: unknown[] = [];
    for (const [, sess] of sessions) {
      list.push(sess.toSnapshot());
    }

    return {
      type: 'snapshot', sessions: list, packVersions: getPackVersions(), serverBuild: serverBuild(),
    };
  }

  const SESSION_NAME_RE = /^[a-zA-Z0-9_\-. ()]{1,64}$/;

  function handleAddSession(msg: ControlRequest, ws: ControlSocket): void {
    const name = (msg.name || '').trim();
    const projectPath = (msg.path || '').trim();

    if (!name || !projectPath) {
      sendError(ws, 'Name and path are required');
      return;
    }

    if (!SESSION_NAME_RE.test(name)) {
      sendError(ws, 'Session name may only contain letters, numbers, spaces, dashes, dots, underscores, and parentheses (max 64 chars)');
      return;
    }

    const requestedAgent = typeof msg.agent === 'string' ? msg.agent.trim() : '';
    if (requestedAgent && !isKnownAgentId(requestedAgent)) {
      sendError(ws, `Unknown agent "${requestedAgent}"`);
      return;
    }

    const agent = requestedAgent as NonNullable<ProjectEntry['agent']> | '';

    for (const [, sess] of sessions) {
      if (sess.name === name) {
        sendError(ws, `Session "${name}" already exists`);
        return;
      }
    }

    const resolvedPath = path.resolve(projectPath);
    if (!fs.existsSync(resolvedPath)) {
      sendError(ws, `Path does not exist: ${projectPath}`);
      return;
    }

    const skipPerms = msg.dangerouslySkipPermissions !== false;
    const project: ProjectEntry = { id: generateProjectId(), name, path: resolvedPath };
    if (!skipPerms) project.dangerouslySkipPermissions = false;

    if (agent && agent !== DEFAULT_AGENT_ID) project.agent = agent;

    const freshConfig = configStore.save(cfg => {
      cfg.projects.push(project);
    });
    if (freshConfig) applyConfigReload(freshConfig);
    console.log(`[control] Added session via UI: ${name}${skipPerms ? ' (skip permissions)' : ' (permission prompts)'}`);
  }

  function handleRemoveSession(msg: ControlRequest, ws: ControlSocket): void {
    const sess = findSession(msg);
    if (!sess) {
      sendError(ws, 'Session not found');
      return;
    }

    const freshConfig = configStore.save(cfg => {
      cfg.projects = cfg.projects.filter(p => p.id !== sess.id);
    });
    if (freshConfig) applyConfigReload(freshConfig);
    console.log(`[control] Removed session via UI: ${sess.name}`);
  }

  function handleRenameSession(msg: ControlRequest, ws: ControlSocket): void {
    const sess = findSession(msg);
    const newName = (msg.newName || '').trim();

    if (!sess || !newName) {
      sendError(ws, 'Session and new name are required');
      return;
    }

    if (!SESSION_NAME_RE.test(newName)) {
      sendError(ws, 'Session name may only contain letters, numbers, spaces, dashes, dots, underscores, and parentheses (max 64 chars)');
      return;
    }

    for (const [, other] of sessions) {
      if (other !== sess && other.name === newName) {
        sendError(ws, `Session "${newName}" already exists`);
        return;
      }
    }

    if (sess.name === newName) return;

    const freshConfig = configStore.save(cfg => {
      const project = cfg.projects.find(p => p.id === sess.id);
      if (project) project.name = newName;
    });
    if (freshConfig) applyConfigReload(freshConfig);
  }

  function handleReorderSessions(msg: ControlRequest, ws: ControlSocket): void {
    const order = msg.order;
    if (!Array.isArray(order) || order.length === 0) {
      sendError(ws, 'order must be a non-empty array');
      return;
    }

    const allExist = order.every(id => sessions.has(id));
    if (!allExist) {
      sendError(ws, 'Session list changed during reorder');
      broadcastControl(buildSnapshot());
      return;
    }

    const entries = new Map(sessions);
    sessions.clear();
    for (const id of order) {
      const existing = entries.get(id);
      if (existing) sessions.set(id, existing);
    }
    for (const [id, sess] of entries) {
      if (!sessions.has(id)) {
        sessions.set(id, sess);
      }
    }

    configStore.save(cfg => {
      const projectMap = new Map(cfg.projects.map(p => [p.id, p]));
      cfg.projects = order
        .map(id => projectMap.get(id))
        .filter((project): project is ProjectEntry => project !== undefined);
      for (const p of projectMap.values()) {
        if (!cfg.projects.some(x => x.id === p.id)) {
          cfg.projects.push(p);
        }
      }
    });

    broadcastControl({ type: 'sessions-reordered', order });
    console.log(`[control] Sessions reordered`);
  }

  async function handleListConversations(msg: ControlRequest, ws: ControlSocket): Promise<void> {
    const sess = findSession(msg);
    if (!sess) {
      ws.send(JSON.stringify({ type: 'conversations', requestId: msg.requestId || null, id: msg.id || null, conversations: [], error: 'Session not found' }));
      return;
    }
    let conversations: unknown[] = [];
    try {
      conversations = await listRepoConversations({
        repoPath: sess.path,
        projectsDir: conversationProjectsDir,
        git: conversationGit,
        fsMod: conversationFs,
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: 'conversations', requestId: msg.requestId || null, id: sess.id, conversations: [], error: errorMessage(err) }));
      return;
    }
    ws.send(JSON.stringify({
      type: 'conversations',
      requestId: msg.requestId || null,
      id: sess.id,
      current: sess.resumeSessionId || null,
      conversations,
    }));
  }

  function handleResumeConversation(msg: ControlRequest, ws: ControlSocket): void {
    const sess = findSession(msg);
    if (!sess) { sendError(ws, 'Session not found'); return; }
    if (sess.ephemeral) { sendError(ws, 'This session cannot resume a conversation'); return; }
    const raw = typeof msg.conversationId === 'string' ? msg.conversationId.trim() : '';
    const conversationId = raw || null;
    if (conversationId && !RESUME_ID_RE.test(conversationId)) {
      sendError(ws, 'Invalid conversation id');
      return;
    }

    const freshConfig = configStore.save(cfg => {
      const project = cfg.projects.find(p => p.id === sess.id);
      if (!project) return;
      if (conversationId) project.resumeSessionId = conversationId;
      else delete project.resumeSessionId;
    });
    if (freshConfig) applyConfigReload(freshConfig);

    const live = sessions.get(sess.id) || sess;
    live.setResumeConversation(conversationId);

    broadcastControl({ type: 'session-resume', id: live.id, resumeSessionId: conversationId });
    ws.send(JSON.stringify({ type: 'resume-conversation-ack', id: live.id, resumeSessionId: conversationId, ok: true }));
    console.log(`[control] resume-conversation: id=${live.id} -> ${conversationId || '(cleared)'}`);
  }

  function handleGetSettings(msg: ControlRequest, ws: ControlSocket): void {
    ws.send(JSON.stringify({
      type: 'settings',
      requestId: msg.requestId || null,
      settings: buildSettingsPayload()
    }));
  }

  function handlePing(msg: ControlRequest, ws: ControlSocket): void {
    if (!msg.requestId) return;
    ws.send(JSON.stringify({ type: 'pong', requestId: msg.requestId }));
  }

  function handleUpdateSettings(msg: ControlRequest, ws: ControlSocket): void {
    const parsedSettings = ConfigUpdate.safeParse(msg.settings || {});
    if (!parsedSettings.success) {
      sendError(ws, configIssueMessage(parsedSettings.error), { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }
    const s = parsedSettings.data;

    const incoming: Record<string, unknown> = s;

    const invalidPaths = (s.repoRoots || []).filter(p => !fs.existsSync(p));
    if (invalidPaths.length > 0) {
      sendError(ws, `Invalid paths: ${invalidPaths.join(', ')}`, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    for (const spec of MILL_SPECS) {
      const millError = validateMillBlock(incoming[spec.name], spec);
      if (!millError) continue;
      sendError(ws, millError, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    const freshConfig = configStore.save(cfg => {
      for (const key of RUNTIME_CONFIG_SCALAR_KEYS) {
        if (incoming[key] == null) continue;
        if (typeof incoming[key] === 'boolean' && configStore.isUnchosenLaunchDefault(cfg, key, incoming[key])) continue;
        cfg[key] = incoming[key];
      }
      if (s.repoRoots != null) cfg.repoRoots = s.repoRoots;
      if (s.prReview != null) cfg.prReview = s.prReview;
      if (s.branchGc != null) cfg.branchGc = s.branchGc;
      if (s.visions != null) cfg.visions = s.visions;
      if (s.posthog != null) cfg.posthog = mergeSettingsBlockOverStored(cfg.posthog, s.posthog);
      if (s.usage != null) cfg.usage = s.usage;
      for (const spec of MILL_SPECS) {
        if (incoming[spec.name] == null) continue;
        cfg[spec.name] = mergeMillBlock(cfg[spec.name], incoming[spec.name], spec);
      }
      if (s.telegram != null) cfg.telegram = mergeSettingsBlockOverStored(cfg.telegram, s.telegram);
    });
    if (!freshConfig) return;
    applySettingsReload(freshConfig);
    const updatedSettings = buildSettingsPayload();

    ws.send(JSON.stringify({
      type: 'settings-updated',
      requestId: msg.requestId || null,
      settings: updatedSettings,
    }));
    broadcastControl({
      type: 'settings-updated',
      settings: updatedSettings,
    });
    console.log('[control] Settings updated via UI');
  }

  function handleListAgents(msg: ControlRequest, ws: ControlSocket): void {
    const agents = listAgentIds().map((id) => {
      const adapter = getAdapter(id);
      if (!adapter) return { id, label: id, resolvable: false };
      const resolved = commandFor(adapter);
      return { id, label: adapter.label || id, resolvable: !!resolved?.path };
    });
    ws.send(JSON.stringify({
      type: 'agents-listed',
      requestId: msg.requestId || null,
      agents,
    }));
  }

  function handleScanRepoRoots(msg: ControlRequest, ws: ControlSocket): void {
    const directories = scanRepoRoots(config.repoRoots);
    ws.send(JSON.stringify({
      type: 'repo-roots-scanned',
      requestId: msg.requestId || null,
      directories
    }));
  }

  async function handleGetPosthogReport(msg: ControlRequest, ws: ControlSocket): Promise<void> {
    const result = await readPosthogReport(msg.issueId, { reportDir: posthogReportsDir || undefined });
    ws.send(JSON.stringify({
      type: 'posthog-report',
      requestId: msg.requestId || null,
      ...result,
    }));
  }

  function findPosthogIssue(projectId: unknown, issueId: unknown) {
    const status = typeof getPosthogStatus === 'function' ? getPosthogStatus() : null;
    const projects = Array.isArray(status?.projects) ? status.projects : [];
    for (const project of projects) {
      if (String(project.projectId) !== String(projectId)) continue;
      const issues = Array.isArray(project.issues) ? project.issues : [];
      const issue = issues.find((row: { issueId?: unknown }) => String(row?.issueId) === String(issueId));
      if (issue) return { issue, projectName: project.name, host: project.host };
    }
    return null;
  }

  function replyTo(ws: ControlSocket, msg: ControlRequest, type: string, payload: Record<string, unknown>): void {
    ws.send(JSON.stringify({ type, requestId: msg.requestId || null, ...payload }));
  }

  function isExistingDirectory(candidate: string): boolean {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  }

  function listSiblingRepoDirs(): { name: string; path: string }[] {
    const entries: { name: string; path: string }[] = [];
    for (const parent of posthogCore.projectParentDirs(config.projects)) {
      try {
        for (const dirent of fs.readdirSync(parent, { withFileTypes: true })) {
          if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
          entries.push({ name: dirent.name, path: path.join(parent, dirent.name) });
        }
      } catch (err) {

        if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') continue;
        console.warn(`[control] posthog auto-create: cannot read ${parent}: ${errorCode(err) || errorMessage(err)}`);
      }
    }
    return entries;
  }

  function autoCreatePosthogProject(projectId: unknown, posthogProjectName: unknown): ProjectEntry | null {
    const projectMap = config.posthog?.projectMap;
    const mappedEntry = projectMap && typeof projectMap === 'object'
      ? (projectMap as Record<string, unknown>)[String(projectId)]
      : undefined;
    const mapped = String(mappedEntry ?? '').trim();
    const mappedDir = posthogCore.isAbsolutePathish(mapped) && isExistingDirectory(mapped) ? mapped : null;
    const match = mappedDir ? null : posthogCore.pickDirectoryForProjectName(posthogProjectName, listSiblingRepoDirs());
    const repoDir = mappedDir || (match && isExistingDirectory(match.path) ? match.path : null);
    if (!repoDir) return null;

    const resolvedPath = path.resolve(repoDir);
    const name = posthogCore.sanitizeSessionName(path.basename(resolvedPath))
      || posthogCore.sanitizeSessionName(posthogProjectName);
    if (!name) return null;
    for (const [, sess] of sessions) {
      if (sess.name === name) return null;
    }

    const project = { id: generateProjectId(), name, path: resolvedPath };
    const freshConfig = configStore.save(cfg => {
      cfg.projects.push(project);
    });
    if (freshConfig) applyConfigReload(freshConfig);
    console.log(`[control] posthog-open-session auto-created session: ${name} (${resolvedPath})`);
    return project;
  }

  function handlePosthogOpenSession(msg: ControlRequest, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'posthog-open-session-result', { ok: false, error: null, ...payload });
    const ref = posthogCore.validateIssueRef(msg);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    const found = findPosthogIssue(ref.projectId, ref.issueId);
    if (!found) { reply({ error: 'That issue is not in the latest PostHog poll' }); return; }
    const project = posthogCore.resolveIssueProject(config.posthog, config.projects, ref.projectId)
      || autoCreatePosthogProject(ref.projectId, found.projectName);
    if (!project) {
      reply({ error: 'No Glissa session is mapped to this PostHog project (set posthog.projectMap)' });
      return;
    }
    const sess = project.id ? sessions.get(project.id) : undefined;
    if (!sess) { reply({ error: `Session "${project.name}" is not loaded` }); return; }
    const prompt = posthogCore.buildIssueSessionPrompt({
      issue: found.issue,
      projectName: found.projectName,
      host: found.host,
      url: found.issue.url,
    });
    const res = sess.pasteTextWhenReady(prompt);
    if (!res.ok) { reply({ error: `Could not write to "${sess.name}" (${res.reason})` }); return; }
    reply({ ok: true, sessionId: sess.id, sessionName: sess.name, pending: res.deferred === true });
    console.log(`[control] posthog-open-session: issue=${ref.issueId} -> session=${sess.name}`);
  }

  async function handlePosthogIssueAction(msg: ControlRequest, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'posthog-issue-action-result', { ok: false, error: null, ...payload });
    const ref = posthogCore.validateIssueRef(msg);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    const found = findPosthogIssue(ref.projectId, ref.issueId);
    if (!found) { reply({ error: 'That issue is not in the latest PostHog poll' }); return; }
    const decision = posthogCore.decideIssueAction(msg.action);
    if (!decision.ok) { reply({ error: decision.error }); return; }
    if (!posthogSetIssueStatus) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = await posthogSetIssueStatus({
      projectId: ref.projectId, issueId: ref.issueId, action: String(msg.action),
    });
    reply({ ok: res.ok === true, error: res.error || null, status: res.status || null });
  }

  async function handlePosthogArchiveInvestigation(msg: ControlRequest, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'posthog-archive-investigation-result', { ok: false, error: null, ...payload });
    const ref = posthogCore.validateInvestigationId(msg.id);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    if (!posthogArchiveInvestigation) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = await posthogArchiveInvestigation({ id: ref.id });
    reply({ ok: res.ok === true, error: res.error || null });
  }

  async function handleRequestUsageReport(msg: ControlRequest, ws: ControlSocket): Promise<void> {
    if (!requestUsageReport) {
      ws.send(JSON.stringify({ type: 'usage-report', requestId: msg.requestId || null, error: 'Usage tracking is not running' }));
      return;
    }
    const requestedDays = typeof msg.days === 'number' ? msg.days : Number.NaN;
    const days = Number.isInteger(requestedDays) && requestedDays > 0 && requestedDays <= USAGE_REPORT_MAX_DAYS ? requestedDays : undefined;
    const report = await requestUsageReport({ days, force: msg.force === true, requestId: msg.requestId || null });
    ws.send(JSON.stringify(report));
  }

  function handleRequestMillReport(msg: ControlRequest, ws: ControlSocket) {
    if (!millReport) {
      ws.send(JSON.stringify({ type: 'mill-report', requestId: typeof msg.requestId === 'string' ? msg.requestId : null, error: 'The context mill is not running' }));
      return;
    }

    return millReport.requestReport(msg, (payload) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    });
  }

  function handleShutdown(): void {
    console.log('[control] Shutdown requested via UI');
    broadcastControl({ type: 'shutting-down' });
    setTimeout(() => {
      if (requestShutdown) requestShutdown();
    }, 200);
  }

  function builtinHooksReport() {
    return describeBuiltinHooks({
      detectScheduledWakeups: config.detectScheduledWakeups !== false,
      detectPackReads: true,
      rtkPath: config.rtk ? resolveRtkPath() : null,
    });
  }

  function hooksReportProjects(): { id: string; name: string; agent: string }[] {
    return (config.projects || [])
      .filter((project): project is ProjectEntry & { id: string; name: string } => (
        typeof project?.id === 'string' && typeof project?.name === 'string'
      ))
      .map((project) => ({ id: project.id, name: project.name, agent: typeof project.agent === 'string' ? project.agent : DEFAULT_AGENT_ID }));
  }

  function handleRequestHooksReport(msg: ControlRequest, ws: ControlSocket): void {
    replyTo(ws, msg, 'hooks-report', {
      ts: Date.now(),
      hooks: readStoredHooks(config.hooks),
      builtin: builtinHooksReport(),
      events: HOOK_EVENT_CATALOG,
      projects: hooksReportProjects(),

      limits: { maxTimeoutSec: HOOK_MAX_TIMEOUT_SEC },
      error: null,
    });
  }

  function handleSaveHook(msg: ControlRequest, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'save-hook-result', { ok: false, error: null, ...payload });
    const input = msg.hook && typeof msg.hook === 'object' ? msg.hook : {};
    const requestedId = typeof input.id === 'string' ? input.id : '';
    if (requestedId && !HOOK_ID_RE.test(requestedId)) { reply({ error: 'hook id is invalid' }); return; }
    const id = requestedId || crypto.randomUUID();

    const stored = requestedId ? readStoredHooks(config.hooks).find((hook) => hook.id === requestedId) : null;
    if (requestedId && !stored) { reply({ error: 'Unknown hook' }); return; }

    const knownProjectIds = new Set(hooksReportProjects().map((project) => project.id));
    for (const projectId of stored?.projects || []) knownProjectIds.add(projectId);
    const normalized = normalizeHook(input, { id, knownProjectIds });
    if (!normalized.ok) { reply({ error: normalized.error }); return; }

    const freshConfig = configStore.save((cfg) => {
      cfg.hooks = upsertHook(rawStoredHooks(cfg.hooks), normalized.hook);
    });
    if (!freshConfig) { reply({ error: 'Could not write config.json' }); return; }
    reply({ ok: true, hook: normalized.hook });
    applyConfigReload(freshConfig);
    broadcastControl({ type: 'hooks-updated', count: readStoredHooks(freshConfig.hooks).length });
    console.log(`[control] save-hook: ${normalized.hook.name} (${normalized.hook.event})`);
  }

  function handleDeleteHook(msg: ControlRequest, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'delete-hook-result', { ok: false, error: null, ...payload });
    const id = typeof msg.id === 'string' ? msg.id : '';

    if (!rawStoredHooks(config.hooks).some((hook) => hook && hook.id === id)) { reply({ error: 'Unknown hook' }); return; }
    const freshConfig = configStore.save((cfg) => {
      const remaining = removeHook(rawStoredHooks(cfg.hooks), id);

      if (remaining.length === 0) delete cfg.hooks;
      if (remaining.length > 0) cfg.hooks = remaining;
    });
    if (!freshConfig) { reply({ error: 'Could not write config.json' }); return; }
    reply({ ok: true, id });
    applyConfigReload(freshConfig);
    broadcastControl({ type: 'hooks-updated', count: readStoredHooks(freshConfig.hooks).length });
    console.log(`[control] delete-hook: ${id}`);
  }

  function handleRestart(): void {
    console.log('[control] Restart requested via UI');
    broadcastControl({ type: 'restarting' });
    setTimeout(() => {
      if (requestRestart) requestRestart();
    }, 200);
  }

  const handlers = {
    'add-session':      handleAddSession,
    'list-conversations': handleListConversations,
    'resume-conversation': handleResumeConversation,
    'remove-session':   handleRemoveSession,
    'rename-session':   handleRenameSession,
    'reorder-sessions': handleReorderSessions,
    'ping':             handlePing,
    'get-settings':     handleGetSettings,
    'update-settings':  handleUpdateSettings,
    'scan-repo-roots':  handleScanRepoRoots,
    'list-agents':      handleListAgents,
    'get-posthog-report': handleGetPosthogReport,
    'posthog-open-session': handlePosthogOpenSession,
    'posthog-issue-action': handlePosthogIssueAction,
    'posthog-archive-investigation': handlePosthogArchiveInvestigation,
    'request-usage-report': handleRequestUsageReport,
    'request-mill-report': handleRequestMillReport,
    'request-hooks-report': handleRequestHooksReport,
    'save-hook': handleSaveHook,
    'delete-hook': handleDeleteHook,
    'kill':             (msg: ControlRequest) => { const s = findSession(msg); if (s) s.killSession(); },
    'start-session':    (msg: ControlRequest) => {
      const s = findSession(msg);
      if (s && s.state === STATES.DORMANT) s.start();
    },
    'restart':          (msg: ControlRequest) => { const s = findSession(msg); if (s) s.restart({ fresh: msg.fresh === true }); },
    'force-restart':    (msg: ControlRequest) => { const s = findSession(msg); if (s) s.forceRestart({ fresh: msg.fresh === true }); },
    'dismiss':          (msg: ControlRequest) => { const s = findSession(msg); if (s) s.dismiss(); },
    'sleep':            (msg: ControlRequest) => { const s = findSession(msg); if (s) s.sleep(); },
    'wake':             (msg: ControlRequest) => { const s = findSession(msg); if (s) s.wake(); },

    'merge-session':              async (msg: ControlRequest, ws: ControlSocket) => { const s = findSession(msg); if (s) reportMergeRefusal(ws, s, await s.mergeWorktree()); },

    'finish-session':             (msg: ControlRequest) => { const s = findSession(msg); if (s) s.finishAndMerge(); },

    'merge-continue-session':     async (msg: ControlRequest, ws: ControlSocket) => { const s = findSession(msg); if (s) reportMergeRefusal(ws, s, await s.mergeAndContinue({ force: msg.force === true })); },
    'discard-session-worktree':   (msg: ControlRequest) => { const s = findSession(msg); if (s) s.discardWorktree(); },

    'resolve-session-merge':      (msg: ControlRequest) => { const s = findSession(msg); if (s) s.pasteMergePrompt(); },
    'request-session-diff':       async (msg: ControlRequest, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;

      const { committed, uncommitted, hasCommits } = await s.getDiff();
      ws.send(JSON.stringify({ type: 'session-diff', id: s.id, committed, uncommitted, hasCommits }));
    },

    'request-branch-sync':        async (msg: ControlRequest, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      const sync = await s.getBranchSync();
      ws.send(JSON.stringify({ type: 'branch-sync-status', id: s.id, ...sync }));
    },

    'resync-branch':               async (msg: ControlRequest, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      const sync = await s.resyncBranch();
      ws.send(JSON.stringify({ type: 'branch-sync-status', id: s.id, ...sync }));
    },
    'debug-state':      (msg: ControlRequest, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) { sendError(ws, 'Session not found'); return; }
      ws.send(JSON.stringify({ type: 'debug-state-response', id: s.id, payload: s.getDebugState() }));
    },
    'shutdown':         handleShutdown,
    'restart-server':   handleRestart,
    'focus-change':     (msg: ControlRequest, ws: ControlSocket) => { if (handleClientFocus) handleClientFocus(ws, !!msg.focused); },
    'request-health-snapshot': (_msg: ControlRequest, ws: ControlSocket) => {
      if (!buildHealthSnapshot) return;
      ws.send(JSON.stringify({ type: 'health-snapshot', stats: buildHealthSnapshot() }));
    },
  };

  const handlerTable: Record<string, ControlHandler> = handlers;

  controlWss.on('connection', (socket: WebSocket, req) => {
    const ws = socket as ControlSocket;
    ws.send(JSON.stringify(buildSnapshot()));

    ws.send(JSON.stringify({ type: 'client-trust', trust: normalizeClientTrust(ws.glissaTrust) }));
    if (buildHealthSnapshot) {
      ws.send(JSON.stringify({ type: 'health-snapshot', stats: buildHealthSnapshot() }));
    }

    const update = typeof getUpdateStatus === 'function' ? getUpdateStatus() : null;
    if (update?.updateAvailable) {
      ws.send(JSON.stringify({ type: 'update-available', ...update }));
    }

    const posthogStatus = typeof getPosthogStatus === 'function' ? getPosthogStatus() : null;
    if (posthogStatus) {
      ws.send(JSON.stringify(posthogStatus));
    }

    const prStatus = typeof getPrStatus === 'function' ? getPrStatus() : null;
    if (prStatus) {
      ws.send(JSON.stringify(prStatus));
    }

    const usageSessions = typeof getUsageSessions === 'function' ? getUsageSessions() : null;
    if (usageSessions) {
      ws.send(JSON.stringify(usageSessions));
    }
    const usageReport = typeof getUsageReport === 'function' ? getUsageReport() : null;
    if (usageReport) {
      ws.send(JSON.stringify(usageReport));
    }

    const millCached = millReport ? millReport.getCachedReport() : null;
    if (millCached) {
      ws.send(JSON.stringify(millCached));
    }

    const planLimits = typeof getPlanLimits === 'function' ? getPlanLimits() : null;
    if (planLimits) {
      ws.send(JSON.stringify(planLimits));
    }

    const since = parseSinceParam(req?.url);
    if (controlReplayLog && since !== null) {
      const { entries, evicted } = controlReplayLog.entriesSince(since);
      for (const entry of entries) ws.send(JSON.stringify(entry));
      if (evicted) console.log(`[control] replay cursor since=${since} is stale; some transient broadcasts were dropped`);
    }

    ws.on('message', (raw) => {
      let msg: Record<string, unknown> | null = null;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        console.warn('[control] Dropped malformed JSON message');
        return;
      }

      const parsedMessage = ClientMessage.safeParse(msg);
      if (!parsedMessage.success) {
        const message = configIssueMessage(parsedMessage.error);
        console.warn(`[control] Dropped invalid client message: ${message}`);
        const reply = requestValidationErrorReply(msg, message);
        if (reply) ws.send(JSON.stringify(reply));
        return;
      }
      const request: ControlRequest = parsedMessage.data;
      if (!Object.hasOwn(handlers, request.type)) return;
      const handler = handlerTable[request.type];

      const result = handler(request, ws);
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
          console.warn(`[control] ${request.type} handler failed: ${errorMessage(err)}`);
        });
      }
      return undefined;
    });
  });

  return { buildSnapshot };
}

export {
  BRANCH_GC_NUMERIC_RANGES,
  DASHBOARD_SETTING_PATHS,
  POSTHOG_NUMERIC_RANGES,
  PR_REVIEW_NUMERIC_RANGES,
  VISIONS_DISPATCH_NUMERIC_RANGES,
  VISIONS_INTENT_NUMERIC_RANGES,
  registerControlHandlers,
};
export type { ControlHandlerDeps, ControlRequest, MillControl };
