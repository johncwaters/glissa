'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TIMEOUT_KEYS, BOOLEAN_KEYS, STRING_KEYS } = require('./config-store');
const { STATES } = require('../shared/states');
const { computeNextFire } = require('./scheduler');
const { listRepoConversations } = require('../session/core/conversation-history');

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
      ws.send(JSON.stringify({ type: 'error', message: 'Name and path are required' }));
      return;
    }

    if (!SESSION_NAME_RE.test(name)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session name may only contain letters, numbers, spaces, dashes, dots, underscores, and parentheses (max 64 chars)' }));
      return;
    }

    // Check for duplicate name
    for (const [, sess] of sessions) {
      if (sess.name === name) {
        ws.send(JSON.stringify({ type: 'error', message: `Session "${name}" already exists` }));
        return;
      }
    }

    const resolvedPath = path.resolve(projectPath);
    if (!fs.existsSync(resolvedPath)) {
      ws.send(JSON.stringify({ type: 'error', message: `Path does not exist: ${projectPath}` }));
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
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    // Ephemeral sessions (e.g. guided team-pack setup) were never persisted to config.projects, so
    // the filter below is a no-op and the config-reload diff explicitly skips them - making the UI
    // remove button a dead click. Tear them down directly instead: kill the PTY, drop the card.
    if (sess.ephemeral) {
      if (removeEphemeralSession) {
        removeEphemeralSession(sess.id);
      } else {
        // Minimal fallback when backend teardown isn't injected (older callers/tests).
        sess.destroy();
        sessions.delete(sess.id);
        broadcastControl({ type: 'session-removed', id: sess.id, session: sess.name });
        console.log(`[control] Removed session via UI: ${sess.name}`);
      }
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
      ws.send(JSON.stringify({ type: 'error', message: 'Session and new name are required' }));
      return;
    }

    if (!SESSION_NAME_RE.test(newName)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session name may only contain letters, numbers, spaces, dashes, dots, underscores, and parentheses (max 64 chars)' }));
      return;
    }

    // Check for duplicate name (excluding self)
    for (const [, other] of sessions) {
      if (other !== sess && other.name === newName) {
        ws.send(JSON.stringify({ type: 'error', message: `Session "${newName}" already exists` }));
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
      ws.send(JSON.stringify({ type: 'error', message: 'order must be a non-empty array' }));
      return;
    }

    // order is an array of session ids
    const allExist = order.every(id => sessions.has(id));
    if (!allExist) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session list changed during reorder' }));
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
    if (!sess) { ws.send(JSON.stringify({ type: 'error', message: 'Session not found' })); return; }
    if (sess.ephemeral) { ws.send(JSON.stringify({ type: 'error', message: 'This session cannot resume a conversation' })); return; }
    const raw = typeof msg.conversationId === 'string' ? msg.conversationId.trim() : '';
    const conversationId = raw || null;
    if (conversationId && !RESUME_ID_RE.test(conversationId)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid conversation id' }));
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
      ws.send(JSON.stringify({
        type: 'settings-error',
        requestId: msg.requestId || null,
        message: `Invalid paths: ${invalidPaths.join(', ')}`
      }));
      return;
    }

    for (const key of TIMEOUT_KEYS) {
      if (s[key] != null && (typeof s[key] !== 'number' || s[key] <= 0)) {
        ws.send(JSON.stringify({
          type: 'settings-error',
          requestId: msg.requestId || null,
          message: `${key} must be a positive number`
        }));
        return;
      }
    }

    for (const key of BOOLEAN_KEYS) {
      if (s[key] != null && typeof s[key] !== 'boolean') {
        ws.send(JSON.stringify({
          type: 'settings-error',
          requestId: msg.requestId || null,
          message: `${key} must be a boolean`
        }));
        return;
      }
    }

    for (const key of STRING_KEYS) {
      if (s[key] != null && typeof s[key] !== 'string') {
        ws.send(JSON.stringify({
          type: 'settings-error',
          requestId: msg.requestId || null,
          message: `${key} must be a string`
        }));
        return;
      }
    }

    const freshConfig = configStore.save(cfg => {
      for (const key of TIMEOUT_KEYS) {
        if (s[key] != null) cfg[key] = s[key];
      }
      for (const key of BOOLEAN_KEYS) {
        if (s[key] != null) cfg[key] = !!s[key];
      }
      for (const key of STRING_KEYS) {
        if (s[key] != null) cfg[key] = String(s[key]);
      }
      if (s.repoRoots != null) cfg.repoRoots = s.repoRoots;
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
              optional: !!s.optional,
            })),
          });
        } catch { /* skip an invalid team definition */ }
      }
    }
    ws.send(JSON.stringify({ type: 'teams', requestId: msg.requestId || null, teams, activations: config.teams || [] }));
  }

  function handleRunTeam(msg, ws) {
    if (!orchestrator) { ws.send(JSON.stringify({ type: 'error', message: 'Teams are not available' })); return; }
    const { teamId, projectId } = msg;
    if (!teamId || !projectId) { ws.send(JSON.stringify({ type: 'error', message: 'teamId and projectId are required' })); return; }
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
      ws.send(JSON.stringify({ type: 'error', requestId: msg.requestId || null, message: err.message }));
      return;
    }
    ws.send(JSON.stringify(out));
  }

  function handleSetTeamSchedule(msg, ws) {
    const { teamId, projectId } = msg;
    if (!teamId || !projectId) { ws.send(JSON.stringify({ type: 'error', message: 'teamId and projectId are required' })); return; }
    const fresh = configStore.save((cfg) => {
      cfg.teams = Array.isArray(cfg.teams) ? cfg.teams : [];
      let entry = cfg.teams.find((e) => e.teamId === teamId && e.projectId === projectId);
      if (!entry) { entry = { teamId, projectId, enabled: false }; cfg.teams.push(entry); }
      if (msg.schedule != null) entry.schedule = msg.schedule;
      if (msg.enabled != null) entry.enabled = !!msg.enabled;
    });
    if (fresh) {
      config.teams = fresh.teams;
      if (scheduler && typeof scheduler.reload === 'function') scheduler.reload(fresh.teams);
    }
    ws.send(JSON.stringify({ type: 'team-schedule-updated', teamId, projectId, activations: fresh?.teams || config.teams || [] }));
  }

  // Create a team instance (a roster bound to a project). The same roster may target several
  // projects; one activation per (teamId, projectId) pair. Created disabled (manual-only) until the
  // user turns its schedule on. Broadcast so every connected tab reflects the new instance.
  function handleAddTeamInstance(msg, ws) {
    const { teamId, projectId } = msg;
    if (!teamId || !projectId) { ws.send(JSON.stringify({ type: 'error', message: 'teamId and projectId are required' })); return; }
    if (registry) {
      try { registry.loadTeam(teamId); } catch { ws.send(JSON.stringify({ type: 'error', message: `Unknown team "${teamId}"` })); return; }
    }
    if (getProjectPathById && !getProjectPathById(projectId)) { ws.send(JSON.stringify({ type: 'error', message: 'Unknown project' })); return; }
    const fresh = configStore.save((cfg) => {
      cfg.teams = Array.isArray(cfg.teams) ? cfg.teams : [];
      if (!cfg.teams.some((e) => e.teamId === teamId && e.projectId === projectId)) {
        cfg.teams.push({ teamId, projectId, enabled: false });
      }
    });
    if (fresh) {
      config.teams = fresh.teams;
      if (scheduler && typeof scheduler.reload === 'function') scheduler.reload(fresh.teams);
    }
    broadcastControl({ type: 'team-instance-added', teamId, projectId, activations: fresh?.teams || config.teams || [] });
  }

  // Remove a team instance. Drops the activation only - the on-disk run history under the project is
  // intentionally preserved (removing an instance never deletes the work it produced).
  function handleRemoveTeamInstance(msg, ws) {
    const { teamId, projectId } = msg;
    if (!teamId || !projectId) { ws.send(JSON.stringify({ type: 'error', message: 'teamId and projectId are required' })); return; }
    const fresh = configStore.save((cfg) => {
      cfg.teams = (Array.isArray(cfg.teams) ? cfg.teams : []).filter(
        (e) => !(e.teamId === teamId && e.projectId === projectId),
      );
    });
    if (fresh) {
      config.teams = fresh.teams;
      if (scheduler && typeof scheduler.reload === 'function') scheduler.reload(fresh.teams);
    }
    broadcastControl({ type: 'team-instance-removed', teamId, projectId, activations: fresh?.teams || config.teams || [] });
  }

  // Open one run artifact in the user's configured editor. Path-traversal guards: runId is a single
  // safe segment, artifact must be one of the team's known produced files, and the resolved path must
  // stay inside this team's runs/ directory. The spawn itself lives in backend (openInEditor).
  function handleOpenArtifact(msg, ws) {
    if (!openInEditor) { ws.send(JSON.stringify({ type: 'error', message: 'Opening artifacts is not available' })); return; }
    const { teamId, projectId, runId, artifact } = msg;
    let team = null;
    try { if (registry) team = registry.loadTeam(teamId); } catch { /* reported below */ }
    if (!team) { ws.send(JSON.stringify({ type: 'error', message: `Unknown team "${teamId}"` })); return; }
    const projectPath = getProjectPathById ? getProjectPathById(projectId) : null;
    if (!projectPath) { ws.send(JSON.stringify({ type: 'error', message: 'Unknown project' })); return; }
    // The charset admits dot-only names ("..", "..."); confinePath blocks the traversal anyway, but a
    // run id can never be dot-only, so reject it here too (defense in depth).
    if (!/^[\w.-]+$/.test(String(runId || '')) || /^\.+$/.test(String(runId))) { ws.send(JSON.stringify({ type: 'error', message: 'Invalid run id' })); return; }
    const allowed = new Set(team.stages.map((s) => s.produces));
    allowed.add('chat.md'); // the per-run operator conversation transcript is openable too
    if (!allowed.has(artifact)) { ws.send(JSON.stringify({ type: 'error', message: 'Unknown artifact' })); return; }
    const runsDir = path.join(projectPath, team.outputPath, 'runs');
    const abs = confinePath(runsDir, runId, artifact);
    if (!abs) { ws.send(JSON.stringify({ type: 'error', message: 'Invalid artifact path' })); return; }
    if (!fs.existsSync(abs)) { ws.send(JSON.stringify({ type: 'error', message: 'Artifact not found' })); return; }
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
      ws.send(JSON.stringify({ type: 'error', requestId: msg.requestId || null, message: err.message }));
      return;
    }
    ws.send(JSON.stringify(out));
  }

  // Start the guided pack-setup interview: an interactive Claude session (surfaced as a terminal
  // card) that reads the project, interviews the operator, and fills the pack. The session is spawned
  // by the backend (startPackSetup); on its exit the backend broadcasts an updated team-pack-status.
  function handleSetupTeamPack(msg, ws) {
    if (!startPackSetup) { ws.send(JSON.stringify({ type: 'error', message: 'Guided setup is not available' })); return; }
    const { teamId, projectId } = msg;
    if (!teamId || !projectId) { ws.send(JSON.stringify({ type: 'error', message: 'teamId and projectId are required' })); return; }
    const r = startPackSetup({ teamId, projectId });
    if (!r.ok) { ws.send(JSON.stringify({ type: 'error', message: r.error || 'Could not start setup' })); return; }
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
      ws.send(JSON.stringify({ type: 'error', message: 'Teams are not available' })); return;
    }
    const { teamId, projectId } = msg;
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (!teamId || !projectId) { ws.send(JSON.stringify({ type: 'error', message: 'teamId and projectId are required' })); return; }
    if (!text.trim()) { ws.send(JSON.stringify({ type: 'error', message: 'Message text is required' })); return; }
    if (text.length > 8192) { ws.send(JSON.stringify({ type: 'error', message: 'Message too long (max 8192 chars)' })); return; }
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
      ws.send(JSON.stringify({ type: 'error', requestId: msg.requestId || null, message: err.message }));
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
    'kill':             (msg) => { const s = findSession(msg); if (s) s.killSession(); },
    'start-session':    (msg) => {
      const s = findSession(msg);
      if (s && s.state === STATES.DORMANT) s.start();
    },
    'restart':          (msg) => { const s = findSession(msg); if (s) s.restart(); },
    'force-restart':    (msg) => { const s = findSession(msg); if (s) s.forceRestart(); },
    // Park a session back to DORMANT (kept for reuse). DESTRUCTIVE on an unmerged worktree; the card's
    // inline confirm gates that. parkToDormant self-guards state + the teardown mutex, so just delegate.
    // Ephemeral sessions (never persisted) reset only their in-memory state - inert, no config side effect.
    'park-session':     (msg) => {
      const s = findSession(msg);
      if (!s) return;
      const from = s.state;
      const r = s.parkToDormant();
      console.log(`[control] park-session: id=${s.id} from=${from} result=${JSON.stringify(r)}`);
    },
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
    'debug-state':      (msg, ws) => {
      const s = findSession(msg);
      if (!s) { ws.send(JSON.stringify({ type: 'error', message: 'Session not found' })); return; }
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
    if (buildHealthSnapshot) {
      ws.send(JSON.stringify({ type: 'health-snapshot', stats: buildHealthSnapshot() }));
    }
    // Replay a cached startup update-check result to a client connecting AFTER the check resolved.
    // Guarded for the accessor's absence exactly like buildHealthSnapshot above: existing control-WS
    // tests call registerControlHandlers without getUpdateStatus, and an unguarded call would throw.
    const update = typeof getUpdateStatus === 'function' ? getUpdateStatus() : null;
    if (update && update.updateAvailable) {
      ws.send(JSON.stringify({ type: 'update-available', ...update }));
    }

    // Replay transient broadcasts missed while this client was disconnected. The client
    // declares its own cursor (`?since=<lastSeq>`) since the server holds no per-connection
    // state across a reconnect; absent param (first connect) means no replay. Sent AFTER
    // snapshot/health/update so ordering matches a client that never disconnected.
    const since = parseSinceParam(req && req.url);
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
        || !Object.prototype.hasOwnProperty.call(handlers, msg.type)) return;
      const handler = handlers[msg.type];
      // Run synchronously so a sync handler's side effects land in this tick (the existing tests and
      // callers rely on that). Only an async handler returns a thenable; attach a catch so its rejection
      // can't become an unhandledRejection, and return it so a direct test caller can await completion.
      const result = handler(msg, ws);
      if (result && typeof result.then === 'function') {
        return result.catch((err) => {
          console.warn(`[control] ${msg.type} handler failed: ${err && err.message}`);
        });
      }
    });
  });

  return { buildSnapshot };
}

module.exports = { registerControlHandlers };
