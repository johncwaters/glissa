'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const {
  ClientMessage, RUNTIME_CONFIG_SCALAR_KEYS, ConfigUpdate, configIssueMessage,
} = require('../shared/contracts');
const { STATES } = require('../shared/states');
const { claudeProjectsDir, listRepoConversations } = require('../session/core/conversation-history');
const { normalizeClientTrust } = require('./core/request-trust');
const { PACK_NAME_RE, applyPackDelta, isSelfReferentialPack, sameProjectRecords } = require('./core/pack-core');
const {
  INGEST_SPEC, MEMORY_SPEC, PACK_DISTILLER_SPEC, mergeMillBlock, validateMillBlock,
} = require('./core/settings-mill-core');
const { readPosthogReport } = require('./posthog-report');
const posthogCore = require('./core/posthog-core');
const { buildSettingsPayload: buildSettingsPayloadFrom } = require('./settings-payload');
const { RESUME_ID_RE } = require('../session/core/auto-resume');
const { execFile } = require('./child-process-safe');
const { DEFAULT_AGENT_ID, isKnownAgentId, listAgentIds, getAdapter, commandFor } = require('../session/adapters');
const {
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
  VISIONS_MAX_PER_HOUR_RANGE,
  VISIONS_QUIET_MS_RANGE,
  USAGE_INTEGER_RANGES,
} = require('../shared/settings-ranges');
const { USAGE_VENDOR_KEYS, USAGE_BUDGET_KEYS } = require('../shared/usage-config');

function scanRepoRoots(roots) {
  const results = [];
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
      console.warn(`[settings] Failed to scan root: ${root}: ${err.code || err.message}`);
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
// Listed keys override the default positive floor, allowing zero cooldown and capping baseline days.
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
// `recurrenceDedupe` is the recurrence-dedupe kill switch and defaults to ON, so absence means
// enabled; the poller reads it as `!== false`. allowStatusWrites/dailyDigest were validated and
// persisted here while no module in the lane ever read them, which promised behavior (PostHog writes,
// a digest) that does not exist; a key earns a place in this list when something consumes it.
// `autoFix` is the auto-fix dispatch opt-in and defaults to OFF, so absence means diagnose-only.
const POSTHOG_BOOLEAN_KEYS = Object.freeze(['enabled', 'recurrenceDedupe', 'trafficSpikeEnabled', 'autoFix']);
const POSTHOG_STRING_KEYS = Object.freeze(['host', 'apiKey', 'repoPath']);
const POSTHOG_VALUE_KEYS = Object.freeze(['projects', 'projectMap']);

const USAGE_BOOLEAN_KEYS = Object.freeze(['enabled', 'fetchPricing', 'planLimits', 'rtkSavings']);
const USAGE_VALUE_KEYS = Object.freeze(['costMode', 'extraProjectsDirs']);
const TELEGRAM_STRING_KEYS = Object.freeze(['botToken', 'chatId']);

// A settings payload never echoes a stored secret (server/config-store.js redacts both blocks), so an
// absent key here means "left alone", not "cleared"; only an explicit value, '' included, rewrites one.
function mergeSettingsBlockOverStored(stored, incoming) {
  const merged = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
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
// Max days a client may ask a usage report to cover, matching the retainDays ceiling.
const USAGE_REPORT_MAX_DAYS = 3650;
const execFileAsync = promisify(execFile);

async function runGitForConversationHistory(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 20000 });
  return stdout;
}

// Single wire-format builder for every 'error'/'settings-error' reply, so all call sites agree on the
// shape. `requestId` is omitted from the payload entirely when not passed (matches every call site that
// never carried one), rather than defaulting to null, to keep the wire format byte-identical to before.
function sendError(ws, message, { type = 'error', requestId } = {}) {
  const payload = requestId !== undefined ? { type, requestId, message } : { type, message };
  ws.send(JSON.stringify(payload));
}

function requestValidationErrorReply(msg, message) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
  const builders = {
    'list-conversations': () => ({ type: 'conversations', requestId, id: typeof msg.id === 'string' ? msg.id : null, conversations: [], error: message }),
    'resume-conversation': () => ({ type: 'resume-conversation-ack', id: typeof msg.id === 'string' ? msg.id : undefined, ok: false, error: message }),
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
    'set-project-packs': () => ({ type: 'set-project-packs-result', requestId, ok: false, error: message }),
  };
  if (Object.hasOwn(builders, msg?.type)) return builders[msg.type]();
  const genericErrorRequests = new Set([
    'request-session-diff',
    'request-branch-sync',
    'resync-branch',
    'debug-state',
    'request-health-snapshot',
  ]);
  if (genericErrorRequests.has(msg?.type)) return { type: 'error', message };
  return null;
}

const MILL_SPECS = [MEMORY_SPEC, PACK_DISTILLER_SPEC, INGEST_SPEC];

// Reads `since` from a `/control?since=<n>` upgrade URL. Returns null for a missing/malformed
// value (no query string, no param, non-numeric) so the caller treats it as "no replay wanted".
function parseSinceParam(url) {
  if (!url) return null;
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return null;
  const raw = new URLSearchParams(url.slice(qIndex + 1)).get('since');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Register control WebSocket handlers using a handler-map dispatch pattern.
 * Dependencies are injected via the deps object (factory pattern).
 *
 * Sessions are keyed by stable `id` (UUID). The mutable `name` is display-only.
 */
function registerControlHandlers(controlWss, deps) {
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
    // Cached last PostHog tick summary (optional - undefined in older callers/tests).
    getPosthogStatus,
    posthogReportsDir = null,
    // PostHog per-issue actions (optional - undefined in older callers/tests, which then refuse).
    posthogSetIssueStatus = null,
    posthogArchiveInvestigation = null,
    // Cached last PR auto-review tick summary (optional - undefined in older callers/tests).
    getPrStatus,
    // Latest built version per context pack (optional - {} in older callers/tests, which then just
    // means no card can be judged stale).
    getPackVersions = () => ({}),
    // Identifies the running backend to the page, so a tab open across a server update reloads
    // instead of talking to a build its bundle predates.
    serverBuild = () => null,
    // Usage lane accessors (optional - undefined in older callers/tests, which then replay nothing and
    // refuse a report request).
    getUsageSessions = null,
    getUsageReport = null,
    requestUsageReport = null,
    getPlanLimits = null,
    // Context mill report accessors (optional - undefined in older callers/tests, which then replay
    // nothing and refuse a report request).
    millReport = null,
    // The pack names a spec file defines, so an assignment can be refused before it is persisted
    // (optional - undefined in older callers/tests, which then refuse every assignment).
    listPackNames = null,
    resolvePackSourceRoots = null,
    // Builds a newly delivered pack before the reload recreates the session that resolves it (optional -
    // undefined in older callers/tests, which then persist the assignment and build nothing).
    ensurePacksBuilt = null,
    // Replay of transient broadcasts missed across a reconnect gap (optional - undefined in
    // older callers/tests; connect then behaves as before, snapshot-only).
    controlReplayLog = null,
    // Last rtk self-install outcome (optional - undefined in older callers/tests, which then report idle).
    getRtkInstallStatus = () => null,
    conversationFs = fs,
    conversationGit = runGitForConversationHistory,
    conversationProjectsDir = claudeProjectsDir(process.env, os.homedir()),
  } = deps;

  function buildSettingsPayload() {
    return buildSettingsPayloadFrom({ configStore, rtkInstallStatus: getRtkInstallStatus() });
  }

  /** Find a session by stable id. */
  function findSession(msg) {
    if (msg.id && sessions.has(msg.id)) return sessions.get(msg.id);
    return null;
  }

  // Human-readable copy for the pre-merge guard refusals (refused: true results from
  // Session.mergeWorktree / mergeAndContinue). Those guards fire BEFORE any merge-status change, so
  // nothing is broadcast for them; this reply to the requesting client is the operator's only feedback.
  const MERGE_REFUSAL_COPY = {
    'destroyed':         'session no longer exists',
    'no-worktree':       'no worktree to merge',
    'merge-in-progress': 'a merge is already in flight on this worktree',
  };

  function reportMergeRefusal(ws, s, r) {
    if (!r || r.refused !== true) return;
    const detail = r.reason === 'not-continuable'
      ? `session state ${s.state} is not mergeable`
      : (MERGE_REFUSAL_COPY[r.reason] || r.reason);
    console.log(`[control] merge refused: id=${s.id} state=${s.state} reason=${r.reason}`);
    ws.send(JSON.stringify({ type: 'session-error', id: s.id, session: s.name, message: `Merge refused: ${detail}.` }));
  }

  function buildSnapshot() {
    const list = [];
    for (const [, sess] of sessions) {
      list.push(sess.toSnapshot());
    }
    // packVersions rides the snapshot rather than a frame of its own: it is global (not per session),
    // and the snapshot is exactly what repairs a client's view on reconnect, which is why the
    // `pack-updated` broadcast needs no replay retention.
    //
    // serverBuild rides it for the same reason. The dashboard is served by the same process, so the
    // only skew case is a tab left open across a server update: it reconnects to a backend whose
    // frames its bundle may not understand. The client compares this across reconnects and reloads on
    // a change (public/app.js), which is cheap insurance against a silently half-broken dashboard.
    return {
      type: 'snapshot', sessions: list, packVersions: getPackVersions(), serverBuild: serverBuild(),
    };
  }

  const SESSION_NAME_RE = /^[a-zA-Z0-9_\-. ()]{1,64}$/;

  function handleAddSession(msg, ws) {
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

    const agent = typeof msg.agent === 'string' ? msg.agent.trim() : '';
    if (agent && !isKnownAgentId(agent)) {
      sendError(ws, `Unknown agent "${agent}"`);
      return;
    }

    // Check for duplicate name
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

    // SECURITY: sessions run with --dangerously-skip-permissions BY DEFAULT (the product default),
    // allowing unrestricted file writes and shell commands without confirmation. The dialog sends
    // dangerouslySkipPermissions:false only when the operator opts into prompts. Glissa's control
    // WebSocket has no authentication (it trusts all localhost connections), so do not expose Glissa
    // beyond localhost without adding auth.
    const skipPerms = msg.dangerouslySkipPermissions !== false; // default YOLO; false === opt-in to prompts
    const project = { id: generateProjectId(), name, path: resolvedPath };
    if (!skipPerms) project.dangerouslySkipPermissions = false; // persist the opt-out so reloads keep it
    // Absent or default means the default adapter; persist only a non-default choice so a Claude Code
    // project record is byte-identical to a pre-picker one.
    if (agent && agent !== DEFAULT_AGENT_ID) project.agent = agent;

    const freshConfig = configStore.save(cfg => {
      cfg.projects.push(project);
    });
    if (freshConfig) applyConfigReload(freshConfig);
    console.log(`[control] Added session via UI: ${name}${skipPerms ? ' (skip permissions)' : ' (permission prompts)'}`);
  }

  function handleRemoveSession(msg, ws) {
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

  function handleRenameSession(msg, ws) {
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

    // Check for duplicate name (excluding self)
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

  function handleReorderSessions(msg, ws) {
    const order = msg.order;
    if (!Array.isArray(order) || order.length === 0) {
      sendError(ws, 'order must be a non-empty array');
      return;
    }

    // order is an array of session ids
    const allExist = order.every(id => sessions.has(id));
    if (!allExist) {
      sendError(ws, 'Session list changed during reorder');
      broadcastControl(buildSnapshot());
      return;
    }

    const entries = new Map(sessions);
    sessions.clear();
    for (const id of order) {
      sessions.set(id, entries.get(id));
    }
    for (const [id, sess] of entries) {
      if (!sessions.has(id)) {
        sessions.set(id, sess);
      }
    }

    configStore.save(cfg => {
      const projectMap = new Map(cfg.projects.map(p => [p.id, p]));
      cfg.projects = order
        .filter(id => projectMap.has(id))
        .map(id => projectMap.get(id));
      for (const p of projectMap.values()) {
        if (!cfg.projects.some(x => x.id === p.id)) {
          cfg.projects.push(p);
        }
      }
    });

    broadcastControl({ type: 'sessions-reordered', order });
    console.log(`[control] Sessions reordered`);
  }

  // List the Claude conversations resumable INTO this session's card: every transcript under the
  // session repo's main checkout and its linked worktrees, newest-first (see
  // session/core/conversation-history.js). Async (it shells out to `git worktree list`); the dispatch
  // loop awaits the returned promise. Replies with the session's current binding so the picker can mark it.
  async function handleListConversations(msg, ws) {
    const sess = findSession(msg);
    if (!sess) {
      ws.send(JSON.stringify({ type: 'conversations', requestId: msg.requestId || null, id: msg.id || null, conversations: [], error: 'Session not found' }));
      return;
    }
    let conversations = [];
    try {
      conversations = await listRepoConversations({
        repoPath: sess.path,
        projectsDir: conversationProjectsDir,
        git: conversationGit,
        fsMod: conversationFs,
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: 'conversations', requestId: msg.requestId || null, id: sess.id, conversations: [], error: err.message }));
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

  // Bind a card to a prior conversation (or clear with a falsy conversationId). Persists
  // resumeSessionId on the project record (survives a server restart) and sets it on the live Session.
  // Deliberately does NOT (re)start: it takes effect on the next start/restart, so a running session is
  // never killed out from under the operator. The frontend decides whether to start a DORMANT card.
  function handleResumeConversation(msg, ws) {
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

    // Re-fetch: a config reload could (in principle) have rebuilt the Session object; set on whatever
    // instance is live now so the binding is never lost to a recreate.
    const live = sessions.get(sess.id) || sess;
    live.setResumeConversation(conversationId);

    broadcastControl({ type: 'session-resume', id: live.id, resumeSessionId: conversationId });
    ws.send(JSON.stringify({ type: 'resume-conversation-ack', id: live.id, resumeSessionId: conversationId, ok: true }));
    console.log(`[control] resume-conversation: id=${live.id} -> ${conversationId || '(cleared)'}`);
  }

  function handleGetSettings(msg, ws) {
    ws.send(JSON.stringify({
      type: 'settings',
      requestId: msg.requestId || null,
      settings: buildSettingsPayload()
    }));
  }

  function handlePing(msg, ws) {
    if (!msg.requestId) return;
    ws.send(JSON.stringify({ type: 'pong', requestId: msg.requestId }));
  }

  function handleUpdateSettings(msg, ws) {
    const parsedSettings = ConfigUpdate.safeParse(msg.settings || {});
    if (!parsedSettings.success) {
      sendError(ws, configIssueMessage(parsedSettings.error), { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }
    const s = parsedSettings.data;

    const invalidPaths = (s.repoRoots || []).filter(p => !fs.existsSync(p));
    if (invalidPaths.length > 0) {
      sendError(ws, `Invalid paths: ${invalidPaths.join(', ')}`, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    for (const spec of MILL_SPECS) {
      const millError = validateMillBlock(s[spec.name], spec);
      if (!millError) continue;
      sendError(ws, millError, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    const freshConfig = configStore.save(cfg => {
      for (const key of RUNTIME_CONFIG_SCALAR_KEYS) {
        if (s[key] == null) continue;
        if (typeof s[key] === 'boolean' && configStore.isUnchosenLaunchDefault(cfg, key, s[key])) continue;
        cfg[key] = s[key];
      }
      if (s.repoRoots != null) cfg.repoRoots = s.repoRoots;
      if (s.prReview != null) cfg.prReview = s.prReview;
      if (s.branchGc != null) cfg.branchGc = s.branchGc;
      if (s.visions != null) cfg.visions = s.visions;
      if (s.posthog != null) cfg.posthog = mergeSettingsBlockOverStored(cfg.posthog, s.posthog);
      if (s.usage != null) cfg.usage = s.usage;
      for (const spec of MILL_SPECS) {
        if (s[spec.name] == null) continue;
        cfg[spec.name] = mergeMillBlock(cfg[spec.name], s[spec.name], spec);
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

  // Probes each registered adapter for a resolvable binary (cached per id by the adapter registry).
  function handleListAgents(msg, ws) {
    const agents = listAgentIds().map((id) => {
      const adapter = getAdapter(id);
      const resolved = commandFor(adapter);
      return { id, label: adapter.label || id, resolvable: !!resolved?.path };
    });
    ws.send(JSON.stringify({
      type: 'agents-listed',
      requestId: msg.requestId || null,
      agents,
    }));
  }

  function handleScanRepoRoots(msg, ws) {
    const directories = scanRepoRoots(config.repoRoots);
    ws.send(JSON.stringify({
      type: 'repo-roots-scanned',
      requestId: msg.requestId || null,
      directories
    }));
  }

  async function handleGetPosthogReport(msg, ws) {
    const result = await readPosthogReport(msg.issueId, { reportDir: posthogReportsDir || undefined });
    ws.send(JSON.stringify({
      type: 'posthog-report',
      requestId: msg.requestId || null,
      ...result,
    }));
  }

  /*
   * The three per-issue Radar actions. All of them are DASHBOARD-EQUIVALENT (open/paste into a
   * session, change an issue status in PostHog, re-run an investigation), so they carry no remote
   * refusal: a paired phone is meant to be able to act on an error the same way the desk dashboard
   * can, and the control WS can already spawn a session anywhere. See
   * server/core/request-trust.js for the actions that do need the local listener.
   *
   * Every reply is a requestId round-trip, so an OLD client (which never sends these) sees nothing
   * new on the wire.
   */

  // The facts one issue is currently known by, read from the last tick summary rather than from the
  // client: the row's own title/counts arrive over the same socket, but trusting them would let any
  // control-WS message choose the text pasted into a session.
  function findPosthogIssue(projectId, issueId) {
    const status = typeof getPosthogStatus === 'function' ? getPosthogStatus() : null;
    const projects = Array.isArray(status?.projects) ? status.projects : [];
    for (const project of projects) {
      if (String(project.projectId) !== String(projectId)) continue;
      const issues = Array.isArray(project.issues) ? project.issues : [];
      const issue = issues.find((row) => String(row?.issueId) === String(issueId));
      if (issue) return { issue, projectName: project.name, host: project.host };
    }
    return null;
  }

  function replyTo(ws, msg, type, payload) {
    ws.send(JSON.stringify({ type, requestId: msg.requestId || null, ...payload }));
  }

  function isExistingDirectory(candidate) {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  }

  // Everything one level inside the folders the operator already keeps repos in. One-shot cold path
  // (an operator click that is about to spawn a Claude session), so sync readdir is fine.
  function listSiblingRepoDirs() {
    const entries = [];
    for (const parent of posthogCore.projectParentDirs(config.projects)) {
      try {
        for (const dirent of fs.readdirSync(parent, { withFileTypes: true })) {
          if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
          entries.push({ name: dirent.name, path: path.join(parent, dirent.name) });
        }
      } catch (err) {
        // A parent that is simply gone is ordinary (a project path from another machine), not news.
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;
        console.warn(`[control] posthog auto-create: cannot read ${parent}: ${err.code || err.message}`);
      }
    }
    return entries;
  }

  /**
   * Create the Glissa project a Radar row wants when none is mapped yet, or null when the repo
   * cannot be resolved CONFIDENTLY. Refusing to guess is the point: an auto-created session points a
   * permissionless Claude at a directory, so a wrong directory is worse than the mapping error.
   */
  function autoCreatePosthogProject(projectId, posthogProjectName) {
    const mapped = String(config.posthog?.projectMap?.[String(projectId)] ?? '').trim();
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

  // Open (or wake) the Glissa session mapped to this PostHog project and paste an investigation
  // prompt into it, WITHOUT a trailing CR: the operator reads the draft and presses Enter.
  function handlePosthogOpenSession(msg, ws) {
    const reply = (payload) => replyTo(ws, msg, 'posthog-open-session-result', { ok: false, error: null, ...payload });
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
    const sess = sessions.get(project.id);
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

  async function handlePosthogIssueAction(msg, ws) {
    const reply = (payload) => replyTo(ws, msg, 'posthog-issue-action-result', { ok: false, error: null, ...payload });
    const ref = posthogCore.validateIssueRef(msg);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    const found = findPosthogIssue(ref.projectId, ref.issueId);
    if (!found) { reply({ error: 'That issue is not in the latest PostHog poll' }); return; }
    const decision = posthogCore.decideIssueAction(msg.action);
    if (!decision.ok) { reply({ error: decision.error }); return; }
    if (!posthogSetIssueStatus) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = await posthogSetIssueStatus({
      projectId: ref.projectId, issueId: ref.issueId, action: msg.action,
    });
    reply({ ok: res.ok === true, error: res.error || null, status: res.status || null });
  }

  // Archive one investigations-inbox record. The id is a log key, not an issue reference: the record
  // it names routinely outlives the issue row it came from, which is the point of the inbox.
  async function handlePosthogArchiveInvestigation(msg, ws) {
    const reply = (payload) => replyTo(ws, msg, 'posthog-archive-investigation-result', { ok: false, error: null, ...payload });
    const ref = posthogCore.validateInvestigationId(msg.id);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    if (!posthogArchiveInvestigation) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = await posthogArchiveInvestigation({ id: ref.id });
    reply({ ok: res.ok === true, error: res.error || null });
  }

  /*
   * The pulled half of the usage protocol: the report is large (daily + per-model + per-session +
   * blocks), so it is never broadcast, only replied to the requesting socket like
   * request-health-snapshot. `force` re-reads every transcript from offset zero (an operator hard
   * refresh); an out-of-range `days` is dropped rather than rejected, so an old or sloppy client gets
   * the lane's own retention window instead of an error.
   */
  async function handleRequestUsageReport(msg, ws) {
    if (!requestUsageReport) {
      ws.send(JSON.stringify({ type: 'usage-report', requestId: msg.requestId || null, error: 'Usage tracking is not running' }));
      return;
    }
    const days = Number.isInteger(msg.days) && msg.days > 0 && msg.days <= USAGE_REPORT_MAX_DAYS ? msg.days : undefined;
    const report = await requestUsageReport({ days, force: msg.force === true, requestId: msg.requestId || null });
    ws.send(JSON.stringify(report));
  }

  // One pack delivery toggle per message; the delta-not-replace and trust rationale live in AGENTS.md.
  async function handleSetProjectPacks(msg, ws) {
    const reply = (payload) => replyTo(ws, msg, 'set-project-packs-result', { ok: false, error: null, ...payload });
    const projectId = typeof msg.projectId === 'string' ? msg.projectId.trim() : '';
    const project = (config.projects || []).find((p) => p.id === projectId);
    if (!project) { reply({ error: 'Unknown project' }); return; }
    const pack = typeof msg.pack === 'string' ? msg.pack.trim() : '';
    if (!PACK_NAME_RE.test(pack)) { reply({ error: 'pack must be a pack name' }); return; }
    if (typeof msg.deliver !== 'boolean') { reply({ error: 'deliver must be a boolean' }); return; }
    // Only an ADD is checked against the specs. A removal must work even for a name whose spec is gone,
    // which is exactly the list an operator most needs to be able to fix.
    if (msg.deliver) {
      if (!listPackNames) { reply({ error: 'The context mill is not running' }); return; }
      const known = new Set(await listPackNames());
      if (!known.has(pack)) { reply({ error: `No pack spec named "${pack}"` }); return; }
      // Refused at ASSIGNMENT too: a checkbox that ticks and then silently skips every spawn is worse.
      const sourceRoots = resolvePackSourceRoots ? await resolvePackSourceRoots(pack) : [];
      if (isSelfReferentialPack(sourceRoots, project.path)) {
        reply({ error: `Pack "${pack}" is built from files inside this project, which its sessions already load` });
        return;
      }
    }

    // The mutator cannot abort a save, so its verdict comes back out here and a refusal simply leaves
    // the record untouched.
    let outcome = null;
    const freshConfig = configStore.save((cfg) => {
      const records = Array.isArray(cfg.projects) ? cfg.projects : [];
      const record = records.find((p) => p.id === projectId);
      if (!record) { outcome = { error: 'Unknown project' }; return; }
      // Delivery is addressed per PROJECT: every card on this checkout moves together, or one project
      // would deliver a pack to whichever of its cards happened to be ticked.
      const planned = [];
      for (const member of sameProjectRecords(records, record)) {
        const next = applyPackDelta(member.packs, pack, msg.deliver);
        if (!next.ok) { outcome = { error: next.error }; return; }
        planned.push({ member, packs: next.packs });
      }
      outcome = { packs: planned.find((entry) => entry.member === record).packs };
      for (const { member, packs } of planned) {
        // An empty list REMOVES the key, so a project that delivers nothing reads exactly as one that
        // never named a pack.
        if (packs.length === 0) delete member.packs;
        if (packs.length > 0) member.packs = packs;
      }
    });
    if (!freshConfig) { reply({ error: 'Could not write config.json' }); return; }
    // A save whose mutator refused still WROTE (the bytes are unchanged), so the refusal has to be
    // reported here rather than read as success.
    if (outcome?.error) { reply({ error: outcome.error }); return; }

    // Answered before the reload: the write has already landed, and a throw further down must not leave
    // the requester with no frame and a checkbox disabled forever.
    reply({ ok: true, projectId, pack, deliver: msg.deliver, packs: outcome.packs });
    // The Mill tab is a pull surface, so this says "your report is out of date" rather than carrying one.
    broadcastControl({ type: 'project-packs-updated', projectId, packs: outcome.packs });
    console.log(`[control] set-project-packs: ${project.name} ${msg.deliver ? '+' : '-'}${pack}`);

    // Built BEFORE the reload: the respawn resolves packs at spawn, and a first delivery is never yet built.
    if (msg.deliver && ensurePacksBuilt) {
      try {
        // The saved config, not the in-memory one: a per-project pack VARIANT is derived from the
        // assignment this write just landed, and the reload that would publish it runs below.
        await ensurePacksBuilt([pack], freshConfig);
      } catch (err) {
        console.warn(`[control] set-project-packs: build of "${pack}" failed: ${err.message}`);
      }
    }
    applyConfigReload(freshConfig);
  }

  /*
   * The Mill tab's pull: one report per request, assembled on demand from the pack specs, their
   * manifests and the live sessions. Replied to the requesting socket only, like the usage report.
   */
  function handleRequestMillReport(msg, ws) {
    if (!millReport) {
      ws.send(JSON.stringify({ type: 'mill-report', requestId: typeof msg.requestId === 'string' ? msg.requestId : null, error: 'The context mill is not running' }));
      return;
    }
    // The build is async, so the asking socket may be gone by the time it lands.
    return millReport.requestReport(msg, (payload) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    });
  }

  function handleShutdown() {
    console.log('[control] Shutdown requested via UI');
    broadcastControl({ type: 'shutting-down' });
    setTimeout(() => {
      if (requestShutdown) requestShutdown();
    }, 200);
  }

  function handleRestart() {
    console.log('[control] Restart requested via UI');
    broadcastControl({ type: 'restarting' });
    setTimeout(() => {
      if (requestRestart) requestRestart();
    }, 200);
  }

  // Handler map - single dispatch table for all control message types
  // Session action handlers use findSession() for stable id lookup.
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
    'set-project-packs': handleSetProjectPacks,
    'kill':             (msg) => { const s = findSession(msg); if (s) s.killSession(); },
    'start-session':    (msg) => {
      const s = findSession(msg);
      if (s && s.state === STATES.DORMANT) s.start();
    },
    'restart':          (msg) => { const s = findSession(msg); if (s) s.restart({ fresh: msg.fresh === true }); },
    'force-restart':    (msg) => { const s = findSession(msg); if (s) s.forceRestart({ fresh: msg.fresh === true }); },
    'dismiss':          (msg) => { const s = findSession(msg); if (s) s.dismiss(); },
    'sleep':            (msg) => { const s = findSession(msg); if (s) s.sleep(); },
    'wake':             (msg) => { const s = findSession(msg); if (s) s.wake(); },
    // Worktree review gate: merge the session's worktree into the integration branch, throw it away,
    // or stream its diff to the requesting client. Merge PROGRESS/RESULT rides the broadcast
    // 'merge-status' events, but a merge REFUSED by a pre-merge guard (refused: true) changes no
    // status and broadcasts nothing, so reportMergeRefusal replies to the requesting client instead;
    // without it a refused merge click does nothing with zero feedback.
    'merge-session':              async (msg, ws) => { const s = findSession(msg); if (s) reportMergeRefusal(ws, s, await s.mergeWorktree()); },
    // One-click close-out: merge the worktree into the integration branch (develop) and return the
    // session to DORMANT. A live but quiescent session (COMPLETE/IDLE) is ended first, then merged once
    // it settles; a parked/failed merge keeps its worktree (no data loss). All of that is decided in
    // Session.finishAndMerge (which self-guards the state), so the handler just delegates.
    'finish-session':             (msg) => { const s = findSession(msg); if (s) s.finishAndMerge(); },
    // Merge-as-you-go: merge the live session's worktree into the integration branch and rebase the
    // worktree onto it, WITHOUT ending the session, so the operator keeps working and commits as they go.
    // Session.mergeAndContinue self-guards the state and emits 'merge-status' (broadcast) once a merge
    // actually starts; a guard refusal is replied via reportMergeRefusal (see merge-session above).
    'merge-continue-session':     async (msg, ws) => { const s = findSession(msg); if (s) reportMergeRefusal(ws, s, await s.mergeAndContinue({ force: msg.force === true })); },
    'discard-session-worktree':   (msg) => { const s = findSession(msg); if (s) s.discardWorktree(); },
    // Parked-merge handoff: paste a context-rich prompt (why it parked + the conflicting files + how to
    // rebase/resolve) into the session's live PTY so the agent in the worktree can finish the merge.
    // Session.pasteMergePrompt self-guards (parked + live PTY), so the handler just delegates.
    'resolve-session-merge':      (msg) => { const s = findSession(msg); if (s) s.pasteMergePrompt(); },
    'request-session-diff':       async (msg, ws) => {
      const s = findSession(msg);
      if (!s) return;
      // getDiff is async (it shells out to git off the event loop). Awaiting here keeps a large diff
      // from stalling every other session; the reply is sent when git returns.
      const { committed, uncommitted, hasCommits } = await s.getDiff();
      ws.send(JSON.stringify({ type: 'session-diff', id: s.id, committed, uncommitted, hasCommits }));
    },
    // Branch sync: whether this session's project base branch (e.g. develop) is ahead/behind its
    // remote upstream. Sent only in reply to an explicit sidebar open/refresh (see review-sidebar.js
    // requestBranchSync) - never polled. getBranchSync includes a bounded `git fetch` for freshness.
    'request-branch-sync':        async (msg, ws) => {
      const s = findSession(msg);
      if (!s) return;
      const sync = await s.getBranchSync();
      ws.send(JSON.stringify({ type: 'branch-sync-status', id: s.id, ...sync }));
    },
    // On-demand resync: fetch + fast-forward/push the session's project base branch against its remote
    // upstream (never for a diverged branch - Session.resyncBranch enforces that, not this handler).
    // Reuses the branch-sync-status reply shape, additively carrying action/error, so the sidebar's
    // existing branch-sync-status handler updates both the indicator and the resync outcome from one
    // message. Session.resyncBranch coalesces a concurrent call itself, so a duplicate message here can
    // never race two mutating git commands.
    'resync-branch':               async (msg, ws) => {
      const s = findSession(msg);
      if (!s) return;
      const sync = await s.resyncBranch();
      ws.send(JSON.stringify({ type: 'branch-sync-status', id: s.id, ...sync }));
    },
    'debug-state':      (msg, ws) => {
      const s = findSession(msg);
      if (!s) { sendError(ws, 'Session not found'); return; }
      ws.send(JSON.stringify({ type: 'debug-state-response', id: s.id, payload: s.getDebugState() }));
    },
    'shutdown':         handleShutdown,
    'restart-server':   handleRestart,
    'focus-change':     (msg, ws) => { if (handleClientFocus) handleClientFocus(ws, !!msg.focused); },
    'request-health-snapshot': (_msg, ws) => {
      if (!buildHealthSnapshot) return;
      ws.send(JSON.stringify({ type: 'health-snapshot', stats: buildHealthSnapshot() }));
    },
  };

  controlWss.on('connection', (ws, req) => {
    ws.send(JSON.stringify(buildSnapshot()));
    // Per-connection, so it cannot ride the snapshot (that one is also BROADCAST on config reload,
    // which would hand every client whichever connection's trust built it). Sent after the snapshot
    // so that one stays the first frame of a (re)connect, which control-ws.js keys its seq reset on.
    ws.send(JSON.stringify({ type: 'client-trust', trust: normalizeClientTrust(ws.glissaTrust) }));
    if (buildHealthSnapshot) {
      ws.send(JSON.stringify({ type: 'health-snapshot', stats: buildHealthSnapshot() }));
    }
    // Replay a cached startup update-check result to a client connecting AFTER the check resolved.
    // Guarded for the accessor's absence exactly like buildHealthSnapshot above: existing control-WS
    // tests call registerControlHandlers without getUpdateStatus, and an unguarded call would throw.
    const update = typeof getUpdateStatus === 'function' ? getUpdateStatus() : null;
    if (update?.updateAvailable) {
      ws.send(JSON.stringify({ type: 'update-available', ...update }));
    }
    // Same cached-snapshot replay for the PostHog lane: ticks are ~15 minutes apart, so a client
    // connecting between them would otherwise show an empty panel until the next one.
    const posthogStatus = typeof getPosthogStatus === 'function' ? getPosthogStatus() : null;
    if (posthogStatus) {
      ws.send(JSON.stringify(posthogStatus));
    }
    // And the same for the PR auto-review lane, whose ticks are just as far apart.
    const prStatus = typeof getPrStatus === 'function' ? getPrStatus() : null;
    if (prStatus) {
      ws.send(JSON.stringify(prStatus));
    }
    // Usage lane. The per-card payload is rebuilt live (it is small, and the session-to-transcript
    // mapping may have moved since the last push); the report is replayed from its cache only, because
    // building one costs a full aggregate pass no client has asked for yet. Both are null until the
    // lazy first scan lands, which is the same connection that triggered it.
    const usageSessions = typeof getUsageSessions === 'function' ? getUsageSessions() : null;
    if (usageSessions) {
      ws.send(JSON.stringify(usageSessions));
    }
    const usageReport = typeof getUsageReport === 'function' ? getUsageReport() : null;
    if (usageReport) {
      ws.send(JSON.stringify(usageReport));
    }
    // Context mill: replayed from its cache only, for the same reason the usage report is. A client
    // connecting before anyone has asked gets nothing and pulls its own.
    const millCached = millReport ? millReport.getCachedReport() : null;
    if (millCached) {
      ws.send(JSON.stringify(millCached));
    }
    // Official plan limits: account-wide, and pushed only when a percentage actually moves, so a client
    // that connects between statusLine callbacks would otherwise see nothing until the next turn.
    const planLimits = typeof getPlanLimits === 'function' ? getPlanLimits() : null;
    if (planLimits) {
      ws.send(JSON.stringify(planLimits));
    }

    // Replay transient broadcasts missed while this client was disconnected. The client
    // declares its own cursor (`?since=<lastSeq>`) since the server holds no per-connection
    // state across a reconnect; absent param (first connect) means no replay. Sent AFTER
    // snapshot/health/update so ordering matches a client that never disconnected.
    const since = parseSinceParam(req?.url);
    if (controlReplayLog && since !== null) {
      const { entries, evicted } = controlReplayLog.entriesSince(since);
      for (const entry of entries) ws.send(JSON.stringify(entry));
      if (evicted) console.log(`[control] replay cursor since=${since} is stale; some transient broadcasts were dropped`);
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
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
      msg = parsedMessage.data;
      if (!Object.hasOwn(handlers, msg.type)) return;
      const handler = handlers[msg.type];
      // Run synchronously so a sync handler's side effects land in this tick (the existing tests and
      // callers rely on that). Only an async handler returns a thenable; attach a catch so its rejection
      // can't become an unhandledRejection, and return it so a direct test caller can await completion.
      const result = handler(msg, ws);
      if (result && typeof result.then === 'function') {
        return result.catch((err) => {
          console.warn(`[control] ${msg.type} handler failed: ${err?.message}`);
        });
      }
    });
  });

  return { buildSnapshot };
}

module.exports = {
  BRANCH_GC_NUMERIC_RANGES,
  DASHBOARD_SETTING_PATHS,
  POSTHOG_NUMERIC_RANGES,
  PR_REVIEW_NUMERIC_RANGES,
  VISIONS_DISPATCH_NUMERIC_RANGES,
  registerControlHandlers,
};
