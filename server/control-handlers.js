'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TIMEOUT_KEYS, BOOLEAN_KEYS, STRING_KEYS } = require('./config-store');
const { STATES } = require('../shared/states');
const { computeNextFire } = require('./scheduler');
const { listRepoConversations } = require('../session/core/conversation-history');
const { decideEditorOpenAccess, normalizeClientTrust } = require('./core/request-trust');
const { readPosthogReport } = require('./posthog-report');
const posthogCore = require('./core/posthog-core');

// A Claude session id is a UUID, but stay lenient (any safe id charset) so a non-UUID id is not
// rejected. The charset itself is the guard: no path separators, dots, or whitespace can reach the
// spawn arg or be persisted, so a hostile control message cannot inject flags or traverse paths.
const RESUME_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

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

const PR_REVIEW_NUMERIC_KEYS = ['intervalMinutes', 'maxConcurrentReviews', 'reviewTimeoutSeconds'];
const PR_REVIEW_MERGE_METHODS = new Set(['rebase', 'squash', 'merge']);
const POSTHOG_NUMERIC_KEYS = [
  'intervalMinutes',
  'maxConcurrentInvestigations',
  'investigationTimeoutSeconds',
  'minUsersToInvestigate',
  'userEscalationThreshold',
];
// Only `enabled` exists. allowStatusWrites/dailyDigest were validated and persisted here while no
// module in the lane ever read them, which promised behavior (PostHog writes, a digest) that does not
// exist; a key earns a place in this list when something consumes it.
const POSTHOG_BOOLEAN_KEYS = ['enabled'];
const POSTHOG_STRING_KEYS = ['host', 'apiKey', 'repoPath'];

// Single wire-format builder for every 'error'/'settings-error' reply, so all call sites agree on the
// shape. `requestId` is omitted from the payload entirely when not passed (matches every call site that
// never carried one), rather than defaulting to null, to keep the wire format byte-identical to before.
function sendError(ws, message, { type = 'error', requestId } = {}) {
  const payload = requestId !== undefined ? { type, requestId, message } : { type, message };
  ws.send(JSON.stringify(payload));
}

// One data-driven pass over the three settings key-lists instead of three structurally identical loops.
const SETTINGS_VALIDATORS = [
  { keys: TIMEOUT_KEYS, isValid: (v) => typeof v === 'number' && v > 0, label: 'a positive number' },
  { keys: BOOLEAN_KEYS, isValid: (v) => typeof v === 'boolean', label: 'a boolean' },
  { keys: STRING_KEYS, isValid: (v) => typeof v === 'string', label: 'a string' },
];

// Validate the optional nested prReview settings object. Returns an error message, or null when valid
// (a missing/null prReview is valid: the tab was never touched).
function validatePrReview(pr) {
  if (pr == null) return null;
  if (typeof pr !== 'object' || Array.isArray(pr)) return 'prReview must be an object';
  if (pr.enabled != null && typeof pr.enabled !== 'boolean') return 'prReview.enabled must be a boolean';
  if (pr.projects != null && (!Array.isArray(pr.projects) || !pr.projects.every(p => typeof p === 'string'))) {
    return 'prReview.projects must be an array of strings';
  }
  for (const key of PR_REVIEW_NUMERIC_KEYS) {
    if (pr[key] != null && (typeof pr[key] !== 'number' || !Number.isFinite(pr[key]) || pr[key] <= 0)) {
      return `prReview.${key} must be a positive number`;
    }
  }
  if (pr.mergeMethod != null && !PR_REVIEW_MERGE_METHODS.has(pr.mergeMethod)) {
    return 'prReview.mergeMethod must be one of rebase, squash, merge';
  }
  return null;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// Validate the optional nested posthog settings object. Returns an error message, or null when valid
// (a missing/null posthog is valid: the tab was never touched). Same shape and strictness as
// validatePrReview - a wrong type is REJECTED rather than coerced, so a checkbox that somehow sends
// the string 'no' cannot silently enable the lane.
function validatePosthog(ph) {
  if (ph == null) return null;
  if (!isPlainObject(ph)) return 'posthog must be an object';
  for (const key of POSTHOG_BOOLEAN_KEYS) {
    if (ph[key] != null && typeof ph[key] !== 'boolean') return `posthog.${key} must be a boolean`;
  }
  // Empty means unset (same rule as telegram's credentials), so only a non-empty host is URL-checked.
  if (ph.host != null && typeof ph.host !== 'string') return 'posthog.host must be a string';
  if (typeof ph.host === 'string' && ph.host.trim() && !/^https?:\/\//i.test(ph.host.trim())) {
    return 'posthog.host must be an http(s) URL';
  }
  if (ph.apiKey != null && typeof ph.apiKey !== 'string') return 'posthog.apiKey must be a string';
  if (ph.repoPath != null && typeof ph.repoPath !== 'string') return 'posthog.repoPath must be a string';
  if (ph.projects != null && !isValidPosthogProjects(ph.projects)) {
    return 'posthog.projects must be "all" or an array of positive integer project ids';
  }
  for (const key of POSTHOG_NUMERIC_KEYS) {
    if (ph[key] != null && (typeof ph[key] !== 'number' || !Number.isFinite(ph[key]) || ph[key] <= 0)) {
      return `posthog.${key} must be a positive number`;
    }
  }
  if (ph.projectMap != null && !isPlainObject(ph.projectMap)) return 'posthog.projectMap must be an object';
  return null;
}

function isValidPosthogProjects(projects) {
  if (projects === 'all') return true;
  if (!Array.isArray(projects)) return false;
  return projects.every((id) => typeof id === 'number' && Number.isInteger(id) && id > 0);
}

// Validate the optional nested telegram settings object. Empty strings are allowed (they mean unset).
function validateTelegram(t) {
  if (t == null) return null;
  if (typeof t !== 'object' || Array.isArray(t)) return 'telegram must be an object';
  if (t.botToken != null && typeof t.botToken !== 'string') return 'telegram.botToken must be a string';
  if (t.chatId != null && typeof t.chatId !== 'string') return 'telegram.chatId must be a string';
  return null;
}

// Keep only the known prReview fields (drops anything unrecognized, e.g. a stray projectChoices echo).
function sanitizePrReview(pr) {
  const out = {};
  if (pr.enabled != null) out.enabled = !!pr.enabled;
  if (pr.projects != null) out.projects = pr.projects;
  if (pr.intervalMinutes != null) out.intervalMinutes = pr.intervalMinutes;
  if (pr.mergeMethod != null) out.mergeMethod = pr.mergeMethod;
  if (pr.maxConcurrentReviews != null) out.maxConcurrentReviews = pr.maxConcurrentReviews;
  if (pr.reviewTimeoutSeconds != null) out.reviewTimeoutSeconds = pr.reviewTimeoutSeconds;
  return out;
}

// Keep only the known posthog fields (drops anything unrecognized). projectMap is a free-form
// id -> display-name map owned by the dashboard, so it passes through untouched once it is an object.
function sanitizePosthog(ph) {
  const out = {};
  for (const key of POSTHOG_BOOLEAN_KEYS) {
    if (ph[key] != null) out[key] = !!ph[key];
  }
  for (const key of POSTHOG_STRING_KEYS) {
    if (ph[key] != null) out[key] = String(ph[key]).trim();
  }
  if (ph.projects != null) out.projects = ph.projects;
  if (isPlainObject(ph.projectMap)) out.projectMap = ph.projectMap;
  for (const key of POSTHOG_NUMERIC_KEYS) {
    if (ph[key] != null) out[key] = ph[key];
  }
  return out;
}

// Resolve `segments` under `baseDir` and confirm the result stays inside it (path-traversal guard).
// Returns the absolute path, or null when the resolved path escapes baseDir.
function confinePath(baseDir, ...segments) {
  const abs = path.resolve(baseDir, ...segments);
  const rel = path.relative(baseDir, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
}

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
    posthogReinvestigate = null,
    posthogArchiveInvestigation = null,
    // Cached last PR auto-review tick summary (optional - undefined in older callers/tests).
    getPrStatus,
    // Replay of transient broadcasts missed across a reconnect gap (optional - undefined in
    // older callers/tests; connect then behaves as before, snapshot-only).
    controlReplayLog = null,
    // Teams (optional - undefined in older callers/tests).
    registry = null,
    orchestrator = null,
    scheduler = null,
    teamOutput = null,
    getProjectPathById = null,
    openInEditor = null,
    startPackSetup = null,
    removeEphemeralSession = null,
  } = deps;

  /** Find a session by id (primary) with name fallback for legacy clients. */
  function findSession(msg) {
    // Prefer msg.id (stable identifier)
    if (msg.id && sessions.has(msg.id)) return sessions.get(msg.id);
    // Fallback: match by name for backward compatibility
    if (msg.session) {
      for (const [, sess] of sessions) {
        if (sess.name === msg.session) return sess;
      }
    }
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
    return { type: 'snapshot', sessions: list };
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

    // Ephemeral sessions (e.g. guided team-pack setup) were never persisted to config.projects, so
    // the filter below is a no-op and the config-reload diff explicitly skips them - making the UI
    // remove button a dead click. Tear them down directly instead: kill the PTY, drop the card.
    if (sess.ephemeral) {
      if (removeEphemeralSession) {
        removeEphemeralSession(sess.id);
        return;
      }
      // Minimal fallback when backend teardown isn't injected (older callers/tests).
      sess.destroy();
      sessions.delete(sess.id);
      broadcastControl({ type: 'session-removed', id: sess.id, session: sess.name });
      console.log(`[control] Removed session via UI: ${sess.name}`);
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
      conversations = await listRepoConversations({ repoPath: sess.path });
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
      settings: configStore.getSettings()
    }));
  }

  function handleUpdateSettings(msg, ws) {
    const s = msg.settings || {};

    const invalidPaths = (s.repoRoots || []).filter(p => !fs.existsSync(p));
    if (invalidPaths.length > 0) {
      sendError(ws, `Invalid paths: ${invalidPaths.join(', ')}`, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    for (const { keys, isValid, label } of SETTINGS_VALIDATORS) {
      for (const key of keys) {
        if (s[key] != null && !isValid(s[key])) {
          sendError(ws, `${key} must be ${label}`, { type: 'settings-error', requestId: msg.requestId || null });
          return;
        }
      }
    }

    const prReviewError = validatePrReview(s.prReview);
    if (prReviewError) {
      sendError(ws, prReviewError, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    const posthogError = validatePosthog(s.posthog);
    if (posthogError) {
      sendError(ws, posthogError, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    const telegramError = validateTelegram(s.telegram);
    if (telegramError) {
      sendError(ws, telegramError, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    const freshConfig = configStore.save(cfg => {
      for (const key of TIMEOUT_KEYS) {
        if (s[key] != null) cfg[key] = s[key];
      }
      for (const key of BOOLEAN_KEYS) {
        if (s[key] == null) continue;
        // The dialog sends every boolean on every save, so an unrelated change would otherwise
        // write this launch's default (dev debugMode) into config.json permanently and leak it
        // into production. Skipped only while the key is absent AND the value is that default.
        if (configStore.isUnchosenLaunchDefault(cfg, key, !!s[key])) continue;
        cfg[key] = !!s[key];
      }
      for (const key of STRING_KEYS) {
        if (s[key] != null) cfg[key] = String(s[key]);
      }
      if (s.repoRoots != null) cfg.repoRoots = s.repoRoots;
      if (s.prReview != null) cfg.prReview = sanitizePrReview(s.prReview);
      if (s.posthog != null) cfg.posthog = sanitizePosthog(s.posthog);
      if (s.telegram != null) {
        cfg.telegram = {
          botToken: String(s.telegram.botToken || '').trim(),
          chatId: String(s.telegram.chatId || '').trim(),
        };
      }
    });
    if (!freshConfig) return;
    applySettingsReload(freshConfig);
    const updatedSettings = configStore.getSettings();

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
   * session, change an issue status in PostHog, re-run an investigation), so unlike open-artifact
   * they carry no remote refusal: a paired phone is meant to be able to act on an error the same way
   * the desk dashboard can, and the control WS can already spawn a session anywhere. See
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

  // Open (or wake) the Glissa session mapped to this PostHog project and paste an investigation
  // prompt into it, WITHOUT a trailing CR: the operator reads the draft and presses Enter.
  function handlePosthogOpenSession(msg, ws) {
    const reply = (payload) => replyTo(ws, msg, 'posthog-open-session-result', { ok: false, error: null, ...payload });
    const ref = posthogCore.validateIssueRef(msg);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    const found = findPosthogIssue(ref.projectId, ref.issueId);
    if (!found) { reply({ error: 'That issue is not in the latest PostHog poll' }); return; }
    const project = posthogCore.resolveIssueProject(config.posthog, config.projects, ref.projectId);
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

  function handlePosthogReinvestigate(msg, ws) {
    const reply = (payload) => replyTo(ws, msg, 'posthog-reinvestigate-result', { ok: false, error: null, ...payload });
    const ref = posthogCore.validateIssueRef(msg);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    if (!posthogReinvestigate) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = posthogReinvestigate({ projectId: ref.projectId, issueId: ref.issueId });
    reply({ ok: res.ok === true, error: res.error || null });
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

  // --- Teams ---

  function handleListTeams(msg, ws) {
    const teams = [];
    if (registry) {
      for (const id of registry.listTeams()) {
        try {
          const t = registry.loadTeam(id);
          teams.push({
            id: t.id,
            name: t.name,
            description: t.description || '',
            outputPath: t.outputPath,
            schedule: t.schedule,
            stageTimeoutSeconds: t.stageTimeoutSeconds || 900,
            permissions: { mode: t.permissions?.mode || 'interactive', deny: t.permissions?.deny || [] },
            chat: { allowQuestions: t.chat?.allowQuestions !== false },
            stages: t.stages.map((s) => s.id),
            stageDetail: t.stages.map((s) => ({
              id: s.id,
              model: s.model || 'sonnet',
              summary: s.summary || '',
              produces: s.produces,
            })),
          });
        } catch { /* skip an invalid team definition */ }
      }
    }
    ws.send(JSON.stringify({ type: 'teams', requestId: msg.requestId || null, teams, activations: config.teams || [] }));
  }

  function handleRunTeam(msg, ws) {
    if (!orchestrator) { sendError(ws, 'Teams are not available'); return; }
    const { teamId, projectId } = msg;
    if (!teamId || !projectId) { sendError(ws, 'teamId and projectId are required'); return; }
    if (orchestrator.isActive(teamId, projectId)) {
      ws.send(JSON.stringify({ type: 'team-run-skipped', teamId, projectId, reason: 'already-active' }));
      return;
    }
    ws.send(JSON.stringify({ type: 'team-run-accepted', teamId, projectId }));
    // Long-running; do not await. Failures are broadcast by the orchestrator's own events, with a
    // catch here as a backstop for synchronous setup errors (e.g. missing project).
    Promise.resolve(orchestrator.runTeam({ teamId, projectId, trigger: 'manual' }))
      .catch((err) => broadcastControl({ type: 'team-run-failed', teamId, projectId, reason: err.message }));
  }

  function handleCancelTeamRun(msg, ws) {
    if (!orchestrator) return;
    const cancelled = orchestrator.cancelRun(msg.teamId, msg.projectId);
    ws.send(JSON.stringify({ type: 'team-run-cancel-ack', teamId: msg.teamId, projectId: msg.projectId, cancelled }));
  }

  // Everything one instance panel needs in a single round-trip: its run history (newest-first),
  // whether a run is active, and the effective schedule + next fire time (activation override, else
  // the team default). Runs are isolated in a git worktree, so the working-tree state is irrelevant.
  async function handleGetTeamRuns(msg, ws) {
    const { teamId, projectId } = msg;
    const out = {
      type: 'team-runs', requestId: msg.requestId || null, teamId, projectId,
      runs: [], active: false, live: null, nextFire: null, enabled: false, schedule: null,
    };
    try {
      let team = null;
      if (registry) team = registry.loadTeam(teamId);
      const projectPath = getProjectPathById ? getProjectPathById(projectId) : null;
      if (team && teamOutput && projectPath) {
        out.runs = await teamOutput.listRunSummaries(projectPath, team.outputPath, team.stages, 10);
      }
      const activation = (config.teams || []).find((e) => e.teamId === teamId && e.projectId === projectId);
      out.enabled = !!activation?.enabled;
      out.schedule = activation?.schedule || team?.schedule || null;
      if (out.schedule?.days) out.nextFire = computeNextFire(out.schedule);
      if (orchestrator) {
        out.active = orchestrator.isActive(teamId, projectId);
        // Live snapshot so a re-mounting/second client rehydrates the active stage, a continuous
        // elapsed timer, and any in-flight cancel, instead of a blank rail + a zeroed clock.
        if (out.active && typeof orchestrator.getRunState === 'function') {
          out.live = orchestrator.getRunState(teamId, projectId);
        }
      }
    } catch (err) {
      sendError(ws, err.message, { requestId: msg.requestId || null });
      return;
    }
    ws.send(JSON.stringify(out));
  }

  // Applies a fresh teams config (post configStore.save) to the live config and re-arms the scheduler.
  // Shared by set-team-schedule, add-team-instance, and remove-team-instance, which otherwise repeat
  // this same 4-line block after their own configStore.save.
  function applyTeamsConfig(fresh) {
    if (!fresh) return;
    config.teams = fresh.teams;
    if (scheduler && typeof scheduler.reload === 'function') scheduler.reload(fresh.teams);
  }

  function handleSetTeamSchedule(msg, ws) {
    const { teamId, projectId } = msg;
    if (!teamId || !projectId) { sendError(ws, 'teamId and projectId are required'); return; }
    const fresh = configStore.save((cfg) => {
      cfg.teams = Array.isArray(cfg.teams) ? cfg.teams : [];
      let entry = cfg.teams.find((e) => e.teamId === teamId && e.projectId === projectId);
      if (!entry) { entry = { teamId, projectId, enabled: false }; cfg.teams.push(entry); }
      if (msg.schedule != null) entry.schedule = msg.schedule;
      if (msg.enabled != null) entry.enabled = !!msg.enabled;
    });
    applyTeamsConfig(fresh);
    ws.send(JSON.stringify({ type: 'team-schedule-updated', teamId, projectId, activations: fresh?.teams || config.teams || [] }));
  }

  // Create a team instance (a roster bound to a project). The same roster may target several
  // projects; one activation per (teamId, projectId) pair. Created disabled (manual-only) until the
  // user turns its schedule on. Broadcast so every connected tab reflects the new instance.
  function handleAddTeamInstance(msg, ws) {
    const { teamId, projectId } = msg;
    if (!teamId || !projectId) { sendError(ws, 'teamId and projectId are required'); return; }
    if (registry) {
      try { registry.loadTeam(teamId); } catch { sendError(ws, `Unknown team "${teamId}"`); return; }
    }
    if (getProjectPathById && !getProjectPathById(projectId)) { sendError(ws, 'Unknown project'); return; }
    const fresh = configStore.save((cfg) => {
      cfg.teams = Array.isArray(cfg.teams) ? cfg.teams : [];
      if (!cfg.teams.some((e) => e.teamId === teamId && e.projectId === projectId)) {
        cfg.teams.push({ teamId, projectId, enabled: false });
      }
    });
    applyTeamsConfig(fresh);
    broadcastControl({ type: 'team-instance-added', teamId, projectId, activations: fresh?.teams || config.teams || [] });
  }

  // Remove a team instance. Drops the activation only - the on-disk run history under the project is
  // intentionally preserved (removing an instance never deletes the work it produced).
  function handleRemoveTeamInstance(msg, ws) {
    const { teamId, projectId } = msg;
    if (!teamId || !projectId) { sendError(ws, 'teamId and projectId are required'); return; }
    const fresh = configStore.save((cfg) => {
      cfg.teams = (Array.isArray(cfg.teams) ? cfg.teams : []).filter(
        (e) => !(e.teamId === teamId && e.projectId === projectId),
      );
    });
    applyTeamsConfig(fresh);
    broadcastControl({ type: 'team-instance-removed', teamId, projectId, activations: fresh?.teams || config.teams || [] });
  }

  // Open one run artifact in the user's configured editor. Path-traversal guards: runId is a single
  // safe segment, artifact must be one of the team's known produced files, and the resolved path must
  // stay inside this team's runs/ directory. The spawn itself lives in backend (openInEditor).
  function handleOpenArtifact(msg, ws) {
    // A remote-classified connection (a paired phone reaching the second listener) would otherwise
    // open the editor on the server machine and be told it succeeded. Refuse explicitly instead;
    // ws.glissaTrust is stamped at upgrade time and absent when remote mode is off, which the
    // decision reads as local.
    if (!decideEditorOpenAccess(ws.glissaTrust).allow) {
      sendError(ws, 'Artifacts open in an editor on the machine running Glissa, not on this device');
      return;
    }
    if (!openInEditor) { sendError(ws, 'Opening artifacts is not available'); return; }
    const { teamId, projectId, runId, artifact } = msg;
    let team = null;
    try { if (registry) team = registry.loadTeam(teamId); } catch { /* reported below */ }
    if (!team) { sendError(ws, `Unknown team "${teamId}"`); return; }
    const projectPath = getProjectPathById ? getProjectPathById(projectId) : null;
    if (!projectPath) { sendError(ws, 'Unknown project'); return; }
    // The charset admits dot-only names ("..", "..."); confinePath blocks the traversal anyway, but a
    // run id can never be dot-only, so reject it here too (defense in depth).
    if (!/^[\w.-]+$/.test(String(runId || '')) || /^\.+$/.test(String(runId))) { sendError(ws, 'Invalid run id'); return; }
    const allowed = new Set(team.stages.map((s) => s.produces));
    allowed.add('chat.md'); // the per-run operator conversation transcript is openable too
    if (!allowed.has(artifact)) { sendError(ws, 'Unknown artifact'); return; }
    const runsDir = path.join(projectPath, team.outputPath, 'runs');
    const abs = confinePath(runsDir, runId, artifact);
    if (!abs) { sendError(ws, 'Invalid artifact path'); return; }
    if (!fs.existsSync(abs)) { sendError(ws, 'Artifact not found'); return; }
    const r = openInEditor(abs);
    ws.send(JSON.stringify({ type: 'artifact-opened', teamId, projectId, runId, artifact, ok: !!r.ok, error: r.error || null }));
  }

  // Report whether this project's pack for a team is filled in. Drives the dashboard's "set up" state
  // so the operator knows to fill the pack before the first run.
  function handleGetTeamPackStatus(msg, ws) {
    const { teamId, projectId } = msg;
    const out = {
      type: 'team-pack-status', requestId: msg.requestId || null, teamId, projectId,
      configured: false, unfilled: [], packDir: null,
    };
    try {
      let team = null;
      if (registry) team = registry.loadTeam(teamId);
      const projectPath = getProjectPathById ? getProjectPathById(projectId) : null;
      if (team && teamOutput && projectPath && typeof teamOutput.packStatus === 'function') {
        const st = teamOutput.packStatus(projectPath, team.outputPath, team.packRequired, team.packShared);
        out.configured = st.configured;
        out.unfilled = st.unfilled;
        out.packDir = st.packDir;
      }
    } catch (err) {
      sendError(ws, err.message, { requestId: msg.requestId || null });
      return;
    }
    ws.send(JSON.stringify(out));
  }

  // Start the guided pack-setup interview: an interactive Claude session (surfaced as a terminal
  // card) that reads the project, interviews the operator, and fills the pack. The session is spawned
  // by the backend (startPackSetup); on its exit the backend broadcasts an updated team-pack-status.
  function handleSetupTeamPack(msg, ws) {
    if (!startPackSetup) { sendError(ws, 'Guided setup is not available'); return; }
    const { teamId, projectId } = msg;
    if (!teamId || !projectId) { sendError(ws, 'teamId and projectId are required'); return; }
    const r = startPackSetup({ teamId, projectId });
    if (!r.ok) { sendError(ws, r.error || 'Could not start setup'); return; }
    ws.send(JSON.stringify({
      type: 'setup-team-pack-started', teamId, projectId,
      sessionId: r.sessionId, already: !!r.already,
    }));
  }

  // Post an operator message into the active run's conversation (steering note, or the answer to a
  // pending agent QUESTION). The orchestrator records the turn and, if the run is awaiting input,
  // resolves the pause so the stage re-runs with the answer.
  function handlePostTeamMessage(msg, ws) {
    if (!orchestrator || typeof orchestrator.postMessage !== 'function') {
      sendError(ws, 'Teams are not available'); return;
    }
    const { teamId, projectId } = msg;
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (!teamId || !projectId) { sendError(ws, 'teamId and projectId are required'); return; }
    if (!text.trim()) { sendError(ws, 'Message text is required'); return; }
    if (text.length > 8192) { sendError(ws, 'Message too long (max 8192 chars)'); return; }
    const r = orchestrator.postMessage(teamId, projectId, text);
    ws.send(JSON.stringify({
      type: 'team-message-ack', teamId, projectId, ok: !!r.ok, answered: !!r.answered, error: r.ok ? null : (r.reason || 'no active run'),
    }));
  }

  // Return the active run's conversation transcript (+ whether it is awaiting an answer) so a freshly
  // mounted or second client rehydrates the chat pane. Reads chat.md from the active run folder.
  function handleGetTeamChat(msg, ws) {
    const { teamId, projectId } = msg;
    const out = {
      type: 'team-chat', requestId: msg.requestId || null, teamId, projectId,
      messages: [], awaiting: false, pendingQuestion: null,
    };
    try {
      const live = orchestrator?.getRunState?.(teamId, projectId) || null;
      let team = null;
      if (registry) team = registry.loadTeam(teamId);
      const projectPath = getProjectPathById ? getProjectPathById(projectId) : null;
      if (live?.runId && team && teamOutput && projectPath && typeof teamOutput.readChat === 'function') {
        const runDir = path.join(projectPath, team.outputPath, 'runs', live.runId);
        out.messages = teamOutput.readChat(runDir);
        out.awaiting = !!live.awaiting;
        out.pendingQuestion = live.pendingQuestion || null;
      }
    } catch (err) {
      sendError(ws, err.message, { requestId: msg.requestId || null });
      return;
    }
    ws.send(JSON.stringify(out));
  }

  // Handler map - single dispatch table for all control message types
  // Session action handlers use findSession() for id-based lookup with name fallback.
  const handlers = {
    'list-teams':       handleListTeams,
    'run-team':         handleRunTeam,
    'cancel-team-run':  handleCancelTeamRun,
    'post-team-message': handlePostTeamMessage,
    'get-team-chat':    handleGetTeamChat,
    'get-team-runs':    handleGetTeamRuns,
    'set-team-schedule': handleSetTeamSchedule,
    'add-team-instance':    handleAddTeamInstance,
    'remove-team-instance': handleRemoveTeamInstance,
    'open-artifact':        handleOpenArtifact,
    'get-team-pack-status': handleGetTeamPackStatus,
    'setup-team-pack':      handleSetupTeamPack,
    'add-session':      handleAddSession,
    'list-conversations': handleListConversations,
    'resume-conversation': handleResumeConversation,
    'remove-session':   handleRemoveSession,
    'rename-session':   handleRenameSession,
    'reorder-sessions': handleReorderSessions,
    'get-settings':     handleGetSettings,
    'update-settings':  handleUpdateSettings,
    'scan-repo-roots':  handleScanRepoRoots,
    'get-posthog-report': handleGetPosthogReport,
    'posthog-open-session': handlePosthogOpenSession,
    'posthog-issue-action': handlePosthogIssueAction,
    'posthog-reinvestigate': handlePosthogReinvestigate,
    'posthog-archive-investigation': handlePosthogArchiveInvestigation,
    'kill':             (msg) => { const s = findSession(msg); if (s) s.killSession(); },
    'start-session':    (msg) => {
      const s = findSession(msg);
      if (s && s.state === STATES.DORMANT) s.start();
    },
    'restart':          (msg) => { const s = findSession(msg); if (s) s.restart(); },
    'force-restart':    (msg) => { const s = findSession(msg); if (s) s.forceRestart(); },
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
        return;
      }

      // Own-property guard: a bracket lookup on an object literal resolves inherited keys too, so
      // {"type":"__proto__"} would yield Object.prototype and the call below would throw synchronously,
      // crashing the process (no uncaughtException handler exists by design). The null check matters:
      // a literal `null` frame parses fine, and dereferencing .type on it is the same crash class.
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string'
        || !Object.hasOwn(handlers, msg.type)) return;
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

module.exports = { registerControlHandlers };
