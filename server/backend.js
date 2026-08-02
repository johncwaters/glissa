/*
 * Glissa Backend - Express + WebSocket server factory
 *
 * Control WebSocket additions:
 *   Client → Server: { type: 'shutdown' }
 *   Server → Client: { type: 'shutting-down' }
 *
 * Exports a single function `createBackend(httpServer, options)` that wires
 * Express middleware, control/data WebSocket servers, and session management
 * onto a provided HTTP server. Used by both:
 *   - server.js (production: standalone HTTP server)
 *   - vite.config.js (dev: attached to Vite's internal HTTP server)
 *
 * node-pty crash risk: Sessions spawn native PTY processes via node-pty.
 * If the Node process crashes without calling shutdown(), PTY child processes
 * may become orphaned. SIGINT handlers in server.js and the Vite plugin
 * mitigate this for graceful exits, but unexpected crashes (segfault, OOM)
 * cannot be caught. This is a known limitation of node-pty.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Session } = require('../session/sessions');
const { STATES } = require('../shared/states');
const { isSameDirectoryPath } = require('../shared/paths');
const { createConfigStore, generateProjectId, ensureProjectIds, DEFAULT_CONFIG } = require('./config-store');
const { registerControlHandlers } = require('./control-handlers');
const { createReplayLog } = require('./control-replay-core');
const { createLifecycle } = require('./server-lifecycle');
const { NotificationManager } = require('../notifications/notification-manager');
const { createNotifyGate, decideNotification } = require('../session/core/notify-gate');
const { pickAutoResume } = require('../session/core/auto-resume');
const { createToastChannel } = require('../notifications/channels/toast');
const { createWebNotificationChannel } = require('../notifications/channels/web-notification');
const { createRecorder } = require('../session/session-recorder');
const { createWsSender } = require('./ws-sender');
const { HookRouter } = require('../detection/hook-source');
const { sweepOrphans } = require('../detection/settings-injector');
const { spawn } = require('./child-process-safe');
const { checkForUpdate: defaultCheckForUpdate } = require('./update-check');
const { loadTeam, listTeams } = require('../teamlib/team-registry');
const { createOrchestrator } = require('../teamlib/team-orchestrator');
const { createScheduler } = require('./scheduler');
const { createSpawnGate } = require('./spawn-gate');
const { createGitWorkspace, createGitWorkspaceSync } = require('../teamlib/team-git');
const { buildStageSpawnOptions, teamPermissions } = require('../teamlib/team-settings');
const { buildStagePrompt } = require('../teamlib/team-prompt');
const teamOutput = require('../teamlib/team-output');
const { runPostTurnChecks, resolveCheckConfig } = require('./post-turn-checker');
const { createIntegrationRefWatcher } = require('../detection/integration-ref-watch');
const { createIntegrationWatcherPool } = require('../detection/integration-watcher-pool');
const { createTeamSessionFactory } = require('./team-session-factory');
const { createPrReviewWiring } = require('./pr-review-wiring');

// WAITING-state notification escalation cadence (fixed 5 minutes; previously the
// configurable waitingEscalationSeconds setting).
const ESCALATION_INTERVAL_MS = 300000;

/**
 * Create and wire the Glissa backend onto an existing HTTP server.
 *
 * @param {import('http').Server} httpServer - HTTP server to attach to
 * @param {object} options
 * @param {string|null} options.staticDir
 *   'auto'  - detect dist/ vs public/ (production behavior)
 *   null    - skip static serving entirely (Vite mode)
 *   string  - absolute path to serve from
 * @returns {{ shutdown: () => void, port: number, app: import('express').Express }}
 */
// Read-modify-write one field on a session's project record. config.json is the single source of
// truth (design A: persisted at hook time, not shutdown time, so a crash between the hook and this
// write never loses the id), so this always reads fresh off disk rather than trusting `liveConfig`.
// No-ops when the project is absent from cfg.projects (ephemeral team/setup sessions are never
// config-backed). Also updates the matching entry in `liveConfig.projects` (the same array
// resolvePostTurn and friends read) so a later read in this process sees the value without a full
// config reload. Module-level (no createBackend closure) so tests can drive it directly against a
// real configStore - see tests/backend-auto-resume.test.js.
function persistSessionField(configStore, liveConfig, sessionId, field, value) {
  const freshConfig = configStore.save((cfg) => {
    const project = cfg.projects.find((p) => p.id === sessionId);
    if (!project) return;
    project[field] = value;
  });
  if (!freshConfig) return;
  const project = liveConfig.projects.find((p) => p.id === sessionId);
  if (project) project[field] = value;
}

// Pure decision for the wasActive boot-time auto-resume signal (design B): what a single
// state-change entry should flip it to, or null for no flip. true = the session now has a live
// PTY; false = an intentional stop (a genuine user_kill, or a terminal DONE/FAILED exit) that
// should not come back next boot. `pendingRestart` exempts forceRestart()'s transient user_kill
// on its way back to a respawn (Session.pendingRestart) - that window is not the operator giving
// up on the session, so a crash mid-restart still needs to resume on the next boot. Module-level
// and pure (no Session/config access) so tests can drive every case directly - see
// tests/backend-auto-resume.test.js.
function decideWasActiveFlip(to, event, pendingRestart) {
  if (to === STATES.STARTING || to === STATES.RUNNING) return true;
  if (!pendingRestart && (event === 'user_kill' || to === STATES.DONE || to === STATES.FAILED)) return false;
  return null;
}

// A config modify (path or permission change) replaces the Session OBJECT, but destroy() leaves the
// old instance's on-disk worktree checked out on the session branch. Without a carry-over the new
// Session provisions fresh, finds its own surviving branch as branch-in-use, and falls back to running
// IN PLACE in the operator's real tree (the recreate sibling of the double-start race Session.start()'s
// single-flight guard closes). Same project path -> the new Session adopts the surviving worktree and
// resumes in it (mirrors the boot reconcile's re-adopt). Path changed -> the worktree belongs to the
// OLD repo and can never serve the new path: once the old PTY's kill reap settles (a live process
// holding the worktree as cwd blocks removal on Windows), Session.discardWorktreeIfClean discards a
// clean worktree junction-safe and leaves one with uncommitted work on disk untouched (no data loss -
// the same settle _settleWorktreeOnExit uses). NOTE a kept worktree becomes an orphan the boot reconcile can no longer
// see (it only visits paths still in config.projects), so it waits for manual reconcile or a future
// project entry at the old path. Module-level so tests drive it with fake sessions directly.
// Same physical directory despite spelling differences: Windows paths are case-insensitive and a
// config hand-edit can change only casing or a trailing separator, which must NOT count as a repo
// change (misclassifying it would skip the adopt and reproduce the branch-in-use fallback); the
// case-fold compare lives in shared/paths.js isSameDirectoryPath.
function carryWorktreeAcrossRecreate(oldSess, newSess) {
  if (!oldSess || !oldSess.worktreeDir || !oldSess._workspace) return;
  if (isSameDirectoryPath(newSess.path, oldSess.path)) {
    // adoptWorktree is synchronous by contract: the caller's newSess.start() right after this relies
    // on worktreeDir being set before it provisions. Best-effort like the provision fallback - a
    // failed adopt (e.g. the dir vanished) leaves the session provisioning fresh, never crashes the
    // config-reload handler.
    try {
      newSess.adoptWorktree({
        worktreeDir: oldSess.worktreeDir,
        branch: oldSess._workspace.branch,
        base: oldSess._workspace.base,
      });
    } catch (err) {
      console.warn(`[config] worktree carry-over adopt failed for ${newSess.name}: ${err.message}`);
    }
    return;
  }
  return Promise.resolve(oldSess._killReap)
    .catch(() => {})
    .then(() => oldSess.discardWorktreeIfClean())
    .catch(() => { /* best-effort */ });
}

// Boot-time smart auto-resume (design C): spawn every picked, still-DORMANT session through
// `gate` so N picks at boot never race pty.spawn against each other - the ConPTY wedge risk
// spawn-gate.js exists for, worse at boot (many sessions can be picked at once) than a single
// user click. A picked id absent from `sessionsMap` (deleted project between reads) is skipped
// up front, but the DORMANT check must happen INSIDE the gate callback, at execution time, not
// while enqueuing: the gate can serialize a picked session's start() seconds behind others, and a
// session the user already started (via the plain start-session control path) and that already
// SETTLED must not be respawned when this queued job finally runs - Session.start()'s single-flight
// guard only collapses starts that are still in flight, not a completed one.
// Returns a promise that resolves once every picked run has settled (module-level,
// no createBackend closure, so tests can drive it directly with fake Session instances - see
// tests/backend-auto-resume.test.js).
function runAutoResume(sessionsMap, cfg, gate) {
  const ids = pickAutoResume(cfg.projects, cfg);
  const runs = [];
  for (const id of ids) {
    const sess = sessionsMap.get(id);
    if (!sess) continue;
    runs.push(
      gate.run(() => {
        if (sess.state !== STATES.DORMANT) return null;
        return sess.start();
      }).catch((err) => {
        console.warn(`[boot] auto-resume failed for ${sess.name}: ${err.message}`);
      })
    );
  }
  return Promise.all(runs);
}

// Boot reconcile of the on-disk session worktrees a prior run left behind (clean shutdown OR crash).
// Four outcomes, chosen so no path destroys work and no resumable session is stranded:
//   CLAIMED (a session in `sessions` owns the id) -> always adopted, so the session keeps its worktree:
//     with work it resurfaces as pending-review (review/merge, or resuming reuses it); CLEAN it adopts
//     ungated (mergeStatus 'none'), which is the survive-shutdown case - Session._settleWorktreeOnExit
//     no longer discards a clean tree on a destroyed session, so auto-resume must land back in the SAME
//     worktree instead of finding it removed and provisioning a fresh one.
//   UNCLAIMED with work -> kept with a warning: no session owns the id (deleted project, or a foreign
//     glissa/session/* branch sharing the naming, e.g. a Claude Code session worktree), and removing it
//     would destroy uncommitted work. Left for manual review, same as sweepSessionWorktrees.
//   UNCLAIMED and clean -> removed junction-safe. A true leftover orphan.
// Module-level with injected dependencies so tests drive it with fakes; booting createBackend against a
// real repo to exercise this would delete that repo's own glissa/session/* worktrees.
function reconcileSessionWorktrees({ projects, sessions, gitWorkspaceSync, integrationBranch, onAdopt, worktreeDirExists = fs.existsSync, log = console.log, warn = console.warn }) {
  const reconciledRoots = new Set();
  for (const project of projects) {
    if (!project.path || reconciledRoots.has(project.path)) continue;
    reconciledRoots.add(project.path);
    for (const wt of gitWorkspaceSync.listSessionWorktrees({ projectPath: project.path, integrationBranch })) {
      const sess = sessions.get(wt.id);
      // Adopt only a coherent claim: the session must still live in THIS repo (a project whose path was
      // edited away must not adopt a tree in the old repo) and the directory must still exist (a
      // vanished-but-unpruned worktree still lists, as clean, so it falls through to the prune below).
      if (sess && isSameDirectoryPath(sess.path, project.path) && worktreeDirExists(wt.cwd)) {
        sess.adoptWorktree({
          worktreeDir: wt.cwd,
          branch: wt.branch,
          base: wt.integrationBranch || integrationBranch,
          hasUnmergedWork: wt.hasWork,
        });
        if (onAdopt) onAdopt(sess, wt);
        log(`[worktree] re-adopted ${wt.hasWork ? 'pending-review' : 'clean'} worktree for ${sess.name} (${wt.branch})`);
        continue;
      }
      if (wt.hasWork) {
        warn(`[worktree] keeping orphan worktree with unmerged work: ${wt.branch} (${wt.cwd})`);
        continue;
      }
      gitWorkspaceSync.removeWorktreeByPath({ projectPath: project.path, cwd: wt.cwd, branch: wt.branch });
    }
  }
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients (curl, ws CLI) have no Origin
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function createBackend(httpServer, options = {}) {
  const { staticDir = 'auto' } = options;

  const configStore = createConfigStore();
  const { config } = configStore;
  const port = process.env.GLISSA_PORT
    ? Number.parseInt(process.env.GLISSA_PORT, 10)
    : (config.port || 3000);

  // --- Detection: shared hook router + per-session settings injection ---
  // The hook port MUST come from the actually-bound server, not config.port:
  // in dev the backend rides Vite's httpServer (e.g. 5173), and createBackend
  // never calls .listen itself, so config.port is fiction there.
  const hookRouter = new HookRouter();
  // Sessions only spawn on user action, long after the server is listening, so
  // the bound address is always available here. Returns null only if (unexpectedly)
  // not listening, in which case the session runs OSC-title-only.
  const getHookPort = () => {
    const addr = httpServer?.address();
    return addr && typeof addr === 'object' && addr.port ? addr.port : null;
  };
  // Clear settings dirs orphaned by prior crashes (best-effort).
  try { sweepOrphans(); } catch { /* ignore */ }

  // Product default: sessions run YOLO (--dangerously-skip-permissions) unless a project record
  // explicitly opts out with `dangerouslySkipPermissions: false`. Absence means YOLO. This is the one
  // place the default is decided; diffProjects() reuses it so a reload sees no phantom perms change.
  const projectSkipPerms = (project) => project.dangerouslySkipPermissions !== false;

  function makeSession(project, cfg) {
    const session = new Session({
      id: project.id,
      name: project.name,
      path: project.path,
      dangerouslySkipPermissions: projectSkipPerms(project),
      replayBufferKB: cfg.replayBufferKB,
      hookRouter,
      getHookPort,
      // Worktree isolation for real user sessions: each forks off the integration branch and merges
      // back on review. Ephemeral team/pack-setup sessions are built elsewhere (not makeSession), so
      // they never receive this and run as they did before.
      gitWorkspace,
      integrationBranch: cfg.integrationBranch || 'develop',
      // Worktree root: a `.glissa-worktrees` sibling of THIS repo by default (attached to the repo,
      // outside its tree - no nested biome/eslint config, clean main git status). A configured
      // worktreeRoot overrides. Plus the gitignored local context to bring in, so the spawned agent
      // sees a complete, recognizable project rather than a bare Temp checkout.
      worktreeRoot: cfg.worktreeRoot || path.join(path.dirname(path.resolve(project.path)), '.glissa-worktrees'),
      worktreeShare: cfg.worktreeShare || DEFAULT_CONFIG.worktreeShare,
      // Background sub-agent detection (config kill switch; undefined -> Session default true).
      detectBackgroundAgents: cfg.detectBackgroundAgents,
      // Scheduled-revival visibility (config kill switch; undefined -> Session default true).
      detectScheduledWakeups: cfg.detectScheduledWakeups,
      // Lever B: preventive anti-slop system prompt (user sessions only; off by default).
      antiSlopPrompt: cfg.antiSlopPrompt,
      // Resume a prior Claude conversation on spawn (set by the per-card "Resume conversation" picker,
      // persisted on the project record). Null = fresh conversation. See control-handlers resume-conversation.
      resumeSessionId: project.resumeSessionId || null,
    });
    // Signals-only by default (kill switch: config recordSignals); cfg.capture opts into raw PTY
    // bytes on top. See AGENTS.md, "Session Recording".
    const recorder = createRecorder(project.name, cfg.capture, cfg.recordSignals ?? DEFAULT_CONFIG.recordSignals);
    if (recorder) {
      session.setRecorder(recorder);
    }
    return session;
  }

  // --- Express setup ---

  const app = express();

  // Hook ingress: Claude Code HTTP hooks POST here (injected via --settings at
  // spawn). Localhost-only + per-session bearer token (validated in HookRouter).
  app.post('/hook/:glissaId/:event', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!(ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) {
      res.status(403).end();
      return;
    }
    let body = '';
    let aborted = false;
    // The oversize req.destroy() below (and any client reset) surfaces as a request 'error' event;
    // without a listener that is an unhandled 'error' throw from the stream.
    req.on('error', () => { aborted = true; });
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) { aborted = true; req.destroy(); }
    });
    req.on('end', () => {
      if (aborted) return;
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { /* tolerate */ }
      const token =
        (req.query?.t) ||
        (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
        null;
      const out = hookRouter.handle({
        glissaId: req.params.glissaId,
        event: req.params.event,
        token,
        payload,
      });
      res.status(out.status).json({ ok: out.status === 200, reason: out.reason });
    });
  });

  if (staticDir === 'auto') {
    const distPath = path.join(__dirname, '..', 'dist');
    const useDistDir = fs.existsSync(distPath) && fs.statSync(distPath).isDirectory();
    const resolvedDir = useDistDir ? 'dist' : 'public';
    app.use(express.static(path.join(__dirname, '..', resolvedDir)));

    if (!useDistDir) {
      mountDevRoutes(app);
    }
  }
  if (staticDir !== 'auto' && typeof staticDir === 'string') {
    app.use(express.static(staticDir));
  }
  // staticDir === null: skip all static serving (Vite mode)

  // --- WebSocket servers (noServer mode) ---

  const controlWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const dataWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  // Stamps every control broadcast with a monotonic seq and retains the replayable ones
  // (notify, session-error, post-turn-result, team-*) so a reconnecting dashboard can
  // recover exactly what it missed (see control-handlers.js connection handler).
  const controlReplayLog = createReplayLog();

  function broadcastControl(msg) {
    controlReplayLog.stamp(msg);
    const payload = JSON.stringify(msg);
    for (const client of controlWss.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }

  // --- Health snapshot ---
  // Periodic memory/leak telemetry. Sampled rather than per-event because
  // process.memoryUsage() walks the V8 heap and shouldn't run on hot paths.

  const HEALTH_SNAPSHOT_INTERVAL_MS = 10000;

  function buildHealthSnapshot() {
    const mem = process.memoryUsage();
    const sessionStats = [];
    let alivePtyCount = 0;
    let sleepingCount = 0;
    let totalDataListeners = 0;
    let totalOutputBufferBytes = 0;
    let listenerMismatch = false;
    let orphanPty = false;
    let destroyedReachable = false;
    for (const sess of [...sessions.values(), ...teamSessions.values(), ...reviewSessions.values()]) {
      const stats = sess.getHealthStats();
      stats.detection = sess.getDetectionStats();
      stats.ephemeral = !!sess.ephemeral;
      sessionStats.push(stats);
      if (stats.hasPty) alivePtyCount++;
      if (stats.sleeping) sleepingCount++;
      totalDataListeners += stats.dataListenerCount;
      totalOutputBufferBytes += stats.outputBufferBytes;
      // Anomaly checks assume a persisted session with tracked data-WS clients and a stable
      // lifecycle. Ephemeral sessions (team stages, PR reviews, guided setup) stream transiently and
      // tear down fast, so they are excluded to avoid false-positive listenerMismatch/orphanPty.
      if (!sess.ephemeral) {
        const clientCount = sessionDataClients.get(stats.id)?.size || 0;
        if (stats.dataListenerCount !== clientCount) listenerMismatch = true;
        if (stats.hasPty && (stats.state === STATES.DONE || stats.state === STATES.FAILED || stats.state === STATES.DORMANT)) {
          orphanPty = true;
        }
      }
      if (stats.destroyed) destroyedReachable = true;
    }
    let dataClientTotal = 0;
    for (const set of sessionDataClients.values()) {
      dataClientTotal += set.size;
    }
    let activeResources = 0;
    try {
      activeResources = process.getActiveResourcesInfo().length;
    } catch {
      // Older Node - leave 0
    }
    return {
      timestamp: Date.now(),
      uptimeSeconds: Math.round(process.uptime()),
      process: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
        activeResources,
      },
      sessions: {
        total: sessions.size,
        alivePty: alivePtyCount,
        sleeping: sleepingCount,
        totalDataListeners,
        totalOutputBufferBytes,
        ephemeralTeamSessions: teamSessions.size,
        activeTeamRuns: orchestrator.activeCount(),
        list: sessionStats,
      },
      websockets: {
        control: controlWss.clients.size,
        data: dataWss.clients.size,
        dataPerSessionTotal: dataClientTotal,
      },
      anomalies: { listenerMismatch, orphanPty, destroyedReachable },
    };
  }

  const healthInterval = setInterval(() => {
    // Cheap fs re-check: a session's cwd can become (or stop being) a linked
    // worktree mid-run. Broadcast only the delta so the card toggles its marker
    // without a full recreate (which would tear down the terminal). This is an fs.statSync only (no git)
    // - the worktree-CHANGE detection it used to also poll here is now fully event-driven: the per-
    // worktree gitdir fs.watch (local commits/stage/reset), the turn-end hook (working-tree edits), and
    // the integration-ref watcher (cross-session / out-of-band merges into the integration branch). The
    // selected session also re-fetches its diff on selection, which is the soft floor for a lossy watch.
    for (const [id, sess] of sessions) {
      if (sess.refreshGitContext()) {
        broadcastControl({ type: 'session-git', id, worktree: !!sess.isWorktree });
      }
    }
    // No control client connected = no listener for the snapshot, so skip the whole build (the per-session
    // iteration + getActiveResourcesInfo + memory). The refreshGitContext loop above still runs so a
    // later-connecting client reads current worktree state; its broadcast is already a no-op at zero
    // clients. A client connecting mid-interval gets its first snapshot on the next tick (<=10s) or via the
    // explicit request-health-snapshot handler the panel sends on expand, so nothing is stale on connect.
    if (controlWss.clients.size === 0) return;
    broadcastControl({ type: 'health-snapshot', stats: buildHealthSnapshot() });
  }, HEALTH_SNAPSHOT_INTERVAL_MS);
  healthInterval.unref();

  // --- Notification manager ---

  const notificationManager = new NotificationManager({
    escalationIntervalMs: ESCALATION_INTERVAL_MS,
    debounceMs: config.notifyDebounceMs || 3000,
  });
  // Primary channel: native browser notifications over the existing control WS.
  // No external deps, no PowerShell, works on every machine that can open the
  // dashboard (the prerequisite for using Glissa at all).
  notificationManager.registerChannel('web', createWebNotificationChannel(broadcastControl));
  // Best-effort OS toast (BurntToast/msg). Off by default: it depends on an
  // unbundled PowerShell module and a flaky `msg *` fallback, so it failed
  // silently on most machines. Opt in via config.osToast for the edge case
  // where no dashboard tab is open.
  if (config.osToast) {
    notificationManager.registerChannel('toast', createToastChannel());
  }

  // --- Client focus tracking (suppress notifications when dashboard is visible) ---

  const focusedClients = new Set();

  function updateNotifySuppression() {
    notificationManager.setFocusSuppressed(focusedClients.size > 0);
  }

  function handleClientFocus(ws, focused) {
    if (focused) focusedClients.add(ws);
    if (!focused) focusedClients.delete(ws);
    updateNotifySuppression();
  }

  // Clean up focus tracking when a control WS client disconnects
  controlWss.on('connection', (ws) => {
    ws.on('error', (err) => {
      console.warn(`[control-ws] Error: ${err.message}`);
    });
    ws.on('close', () => {
      focusedClients.delete(ws);
      updateNotifySuppression();
    });
  });

  // --- Session management ---
  // Sessions are keyed by stable `id` (UUID), not mutable `name`.

  const sessions = new Map();
  const sessionDataClients = new Map();
  // Team-stage sessions live in a SEPARATE map so config hot-reload diffing (diffProjects) never
  // destroys a live stage, and so they are not persisted to config.json. See plan 3.5.
  const teamSessions = new Map();
  // Headless PR-review sessions (opt-in poller). Their own map for the same reasons as teamSessions,
  // and so shutdown() can reap in-flight review PTYs without touching persisted sessions.
  const reviewSessions = new Map();

  function closeSessionDataClients(sessionId) {
    const clients = sessionDataClients.get(sessionId);
    if (clients) {
      for (const ws of clients) {
        ws.close(1001, 'Session removed');
      }
      sessionDataClients.delete(sessionId);
    }
  }

  // --- Teams: registry + orchestrator + scheduler ---

  const TEAMS_DIR = path.join(__dirname, '..', 'teams');
  const registry = {
    listTeams: () => listTeams(TEAMS_DIR),
    loadTeam: (id) => loadTeam(id, TEAMS_DIR),
  };
  const spawnGate = createSpawnGate();
  // Each team run executes in an isolated git worktree on a dedicated branch, fast-forwarded back on
  // success (see team-git.js), so a run never dirties the user's working tree.
  const gitWorkspace = createGitWorkspace();

  // On-disk session worktrees from a prior run are reconciled AFTER the boot session loop below, so a
  // worktree holding unmerged work can be re-adopted onto its session instead of swept (see the
  // reconcile after `for (const project of config.projects)`).

  /** Look up either a persisted session or an ephemeral team-stage session. */
  function getSessionAny(id) {
    return sessions.get(id) || teamSessions.get(id) || null;
  }
  function getProjectPathById(projectId) {
    const p = config.projects.find((x) => x.id === projectId);
    return p ? p.path : null;
  }
  // Open a run artifact in the user's configured editor (Settings > General > Editor command). The
  // command is user-authored and runs on the user's own machine, the same trust level as reading the
  // PTY, so it runs through the shell - `.cmd`/`.bat` shims like `code` resolve. The path is validated
  // and confined to the team's runs/ directory by handleOpenArtifact before it reaches here.
  function openInEditor(absPath) {
    const cmd = (config.editorCommand || '').trim();
    try {
      if (cmd) {
        const quoted = `"${absPath}"`;
        const full = cmd.includes('{file}') ? cmd.replace(/\{file\}/g, quoted) : `${cmd} ${quoted}`;
        spawn(full, { detached: true, stdio: 'ignore', shell: true }).unref();
        return { ok: true };
      }
      if (process.platform === 'win32') {
        // `start` is a cmd builtin; the empty "" is its window-title arg so a quoted path isn't taken as the title.
        spawn('cmd', ['/c', 'start', '', absPath], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true };
      }
      if (process.platform === 'darwin') {
        spawn('open', [absPath], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true };
      }
      spawn('xdg-open', [absPath], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Team-stage + guided-pack-setup Session construction (server/team-session-factory.js).
  const { makeStageSession, startPackSetup } = createTeamSessionFactory({
    config, sessions, teamSessions, closeSessionDataClients, hookRouter, getHookPort,
    wireSessionEvents, broadcastControl, registry, getProjectPathById,
  });

  // GitHub PR auto-review lane (server/pr-review-wiring.js): inert unless config.prReview.enabled and
  // config.telegram are both set. Started at boot below, restarted on a prReview/telegram settings
  // change, stopped in shutdown().
  const prReview = createPrReviewWiring({
    config, reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, gitWorkspace,
    getProjectPathById,
  });

  const orchestrator = createOrchestrator({
    loadTeam: registry.loadTeam,
    getProjectPath: getProjectPathById,
    output: teamOutput,
    buildStagePrompt,
    buildStageSpawnOptions,
    teamPermissions,
    spawnGate,
    makeStageSession,
    gitWorkspace,
    // App-runtime worktree wiring, mirroring the per-session worktree options (see the Session
    // construction above): the gitignored local context to bring in, and the stable per-project
    // worktree root. Consumed only when a team opts in via runtime.shareLocalContext.
    worktreeShare: config.worktreeShare || DEFAULT_CONFIG.worktreeShare,
    getWorktreeBase: (projectPath) => config.worktreeRoot
      || path.join(path.dirname(path.resolve(projectPath)), '.glissa-worktrees'),
    now: () => new Date(),
  });
  for (const ev of ['team-run-started', 'team-stage-started', 'team-stage-complete', 'team-revise-round', 'team-run-cancelling', 'team-run-complete', 'team-run-failed', 'team-run-skipped', 'team-run-needs-setup', 'team-chat-message', 'team-run-awaiting-input', 'team-run-resumed']) {
    orchestrator.on(ev, (payload) => broadcastControl({ type: ev, ...payload, timestamp: Date.now() }));
  }
  orchestrator.on('team-run-complete', ({ teamId, verdict }) => {
    notificationManager.trigger(`team:${teamId}`, 'complete', `Team ${teamId} finished: ${verdict || 'done'}`);
  });
  orchestrator.on('team-run-failed', ({ teamId, reason }) => {
    notificationManager.trigger(`team:${teamId}`, 'failed', `Team ${teamId} failed${reason ? `: ${reason}` : ''}`);
  });

  // One scheduler per enabled activation in config.teams; re-armed on set-team-schedule.
  const teamSchedulers = new Map();
  function armTeamSchedules(teamsCfg) {
    for (const [, s] of teamSchedulers) s.disarm();
    teamSchedulers.clear();
    for (const a of (teamsCfg || [])) {
      if (!a || !a.enabled || !a.teamId || !a.projectId) continue;
      let schedule = a.schedule;
      if (!schedule) {
        try { schedule = registry.loadTeam(a.teamId).schedule; } catch { continue; }
      }
      if (!schedule || !schedule.days) continue;
      const key = `${a.teamId}:${a.projectId}`;
      const sched = createScheduler({
        onFire: () => Promise.resolve(
          orchestrator.runTeam({ teamId: a.teamId, projectId: a.projectId, trigger: 'scheduled' }),
        ).catch((err) => console.warn(`[team-scheduler] ${key} run failed: ${err.message}`)),
      });
      sched.arm(schedule, key);
      teamSchedulers.set(key, sched);
    }
  }
  armTeamSchedules(config.teams);

  // --- Integration-branch watchers (event-driven cross-session gate liveness) ---
  // Replaces the old 10s poll's one unique job: noticing that a session's integration branch moved
  // WITHOUT this session's own worktree changing (another session merged, or an out-of-band CLI merge),
  // which shifts that session's merge gate (its ahead-count vs the branch) with no local gitdir/turn
  // event. The pool keeps at most one reflog fs.watch per (commonGitDir, integration branch) and, on a
  // branch move, re-checks every sibling worktree session on that repo. Unlike the poll this fires only
  // on an actual branch move (no recurring git), and runs server-side regardless of whether a dashboard
  // is open, so gates stay fresh across reconnects. (Ref-count/fan-out logic + tests: integration-watcher-pool.js.)
  const integrationPool = createIntegrationWatcherPool({
    sessions,
    createWatcher: createIntegrationRefWatcher,
    recheck: (s) => s.checkWorktreeChange().catch(() => { /* best-effort; the gitdir watch + turn-end retry */ }),
    isEnabled: () => config.liveWorktreeReview !== false, // master kill-switch for live cross-session review
  });

  function wireSessionEvents(sess) {
    // All closures read sess.id (stable) and sess.name (current) dynamically.
    let ptDebounce = null; // post-turn-check debounce timer (per session closure)
    // Once-per-work-cycle gate for terminal notification categories. Created per wiring
    // closure, so a config-reload destroy + re-wire starts fresh (no cleanup needed).
    const notifyGate = createNotifyGate();
    // Last wasActive value this process persisted for this session, so a burst of RUNNING
    // re-entries (every turn) writes config.json at most once per actual flip. Starts unknown
    // (null) so the first flip always writes, even if it happens to match what's on disk.
    let lastPersistedWasActive = null;

    const persistProjectField = (field, value) => persistSessionField(configStore, config, sess.id, field, value);

    // Crash-safe capture of the live Claude session id (design A): persisted the moment the hook
    // fires, not at shutdown, so a hard kill of Glissa loses nothing. Unifies with the manual
    // Resume-dialog binding (control-handlers.js handleResumeConversation) - same config field.
    sess.on('claude-session-id', ({ id }) => {
      persistProjectField('resumeSessionId', id);
    });

    sess.on('error', (err) => {
      console.error(`[${sess.name}] error: ${err.message}`);
    });

    sess.on('exit', ({ exitCode, signal, reason }) => {
      if (ptDebounce) { clearTimeout(ptDebounce); ptDebounce = null; }
      const reasonStr = reason ? `, reason=${reason}` : '';
      console.log(`[${sess.name}] exited (code=${exitCode}, signal=${signal}${reasonStr})`);
    });

    // Post-turn deterministic checks. The state machine emits `post-turn-check` on
    // entry to COMPLETE (turn ended, process alive: the pre-/commit checkpoint).
    // Gated to real project sessions (not team-stage or ephemeral setup sessions,
    // which run in throwaway worktrees a team manages). Config resolved at run time
    // because config.projects is refreshed on reload; debounced so a burst of
    // turn-ends collapses to one run after the agent settles.
    // Resolve config fresh each call: config.projects is refreshed on reload, and
    // returns null for an ephemeral/team session (not a user project) so it is skipped.
    const resolvePostTurn = () => {
      const proj = config.projects.find((p) => p.id === sess.id);
      return proj ? resolveCheckConfig(config.postTurnChecks, proj.postTurnChecks) : null;
    };
    sess.on('post-turn-check', () => {
      const cfg = resolvePostTurn();
      if (!cfg || !cfg.enabled) return;
      if (ptDebounce) clearTimeout(ptDebounce);
      ptDebounce = setTimeout(() => {
        ptDebounce = null;
        const runCfg = resolvePostTurn(); // re-resolve so a reload during debounce is honored
        if (!runCfg || !runCfg.enabled) return;
        runPostTurnChecks({ cwd: sess.effectiveCwd(), config: runCfg, sessionId: sess.id })
          .then((report) => {
            broadcastControl({ type: 'post-turn-result', id: sess.id, session: sess.name, ...report, timestamp: Date.now() });
          })
          .catch((err) => console.warn(`[${sess.name}] post-turn checks failed: ${err.message}`));
      }, cfg.debounceMs);
    });

    sess.on('state-change', ({ from, to, event, detail }) => {
      broadcastControl({
        type: 'state-change',
        id: sess.id,
        session: sess.name,
        from, to, event,
        timestamp: Date.now()
      });

      // wasActive: the boot-time auto-resume signal (design B; decision logic in
      // decideWasActiveFlip). Flips only, so this writes config.json a handful of times per
      // session lifetime, not on every transition.
      const nextWasActive = decideWasActiveFlip(to, event, sess.pendingRestart);
      if (nextWasActive !== null && nextWasActive !== lastPersistedWasActive) {
        lastPersistedWasActive = nextWasActive;
        persistProjectField('wasActive', nextWasActive);
      }

      // Notification triggers: session state -> notification lifecycle. The decision (which
      // category fires for this state entry, if any) lives in session/core/notify-gate.js
      // decideNotification, shared with its tests. Both turn-complete (COMPLETE) and process
      // exit (DONE) notify under 'complete', but terminal categories pass the once-per-work-cycle
      // gate: a cycle starts on INITIALIZING (restart) or a USER-driven RUNNING entry (event
      // user_input, or an authoritative resume signal; a hook-less session keeps the legacy
      // always-reset), plus the 'user-prompt' listener below for the resume/working race. See
      // notify-gate.js for the full reset rule. 'waiting' stays per-entry (escalation + a later
      // real "needs input" from COMPLETE must keep firing).
      // Acknowledge BEFORE deciding/triggering: on a notifying-to-notifying hop (e.g.
      // WAITING -> COMPLETE via a late authoritative Stop) the old entry must clear
      // first, or the new trigger lands on a live DELIVERED entry and is rejected -
      // the completion toast would be silently swallowed. DONE is included so a restart
      // (DONE -> INITIALIZING) clears the 'complete' entry a direct RUNNING->DONE exit
      // left in DELIVERED; without this the restarted session's next trigger is a no-op
      // and it goes silent.
      if (from === STATES.WAITING || from === STATES.COMPLETE || from === STATES.DONE || from === STATES.FAILED) {
        notificationManager.acknowledge(sess.id);
      }

      const notifyCategory = decideNotification(to, notifyGate, event, { signal: detail?.signal, hookSeen: sess.hookSeen });
      if (notifyCategory) {
        const messages = {
          waiting: `${sess.name} needs your input`,
          complete: `${sess.name} finished working`,
          failed: `${sess.name} failed`,
        };
        notificationManager.trigger(sess.id, notifyCategory, messages[notifyCategory]);
      }
    });

    // An authoritative UserPromptSubmit always resets the notify cycle, even when the racing
    // title 'working' signal won the IDLE/COMPLETE->RUNNING transition (both are immediate in
    // status-source.js, so the transition's detail.signal is not a reliable "was this user-
    // driven" read). A self-wake (mailbox resume) never fires UserPromptSubmit, so it still never
    // resets here.
    sess.on('user-prompt', () => notifyGate.reset());

    // Relay a session event straight onto the control WS, prefixed with this session's id/name and a
    // fresh timestamp. Shared by the five simple delta broadcasts below (session-agents, session-wakeup,
    // session-prompt, session-sleep, session-wake); a handler with extra side effects beyond the
    // broadcast (e.g. worktree-ready, merge-status) stays hand-written.
    const relay = (event, type) => sess.on(event, (payload) => broadcastControl({
      ...payload, type, id: sess.id, session: sess.name, timestamp: Date.now(),
    }));

    // Live background sub-agent count delta -> control WS, so the card shows "N agents" while a
    // background sub-agent keeps running after the main turn's Stop (instead of flipping to Complete).
    // Mirrors the session-git delta: a small targeted update, no full snapshot refetch.
    relay('agents-change', 'session-agents');

    // Pending scheduled-revival delta -> control WS, so a COMPLETE/IDLE card can say
    // "sleeping until ~HH:MM" instead of looking finished while a wakeup is pending.
    // Advisory only (never gates a transition); mirrors the session-agents delta.
    relay('wakeup-change', 'session-wakeup');

    // Pending-prompt-kind delta -> control WS, so a WAITING card shows what it is waiting on
    // (permission vs elicitation). Advisory only; mirrors the session-agents delta.
    relay('prompt-kind-change', 'session-prompt');

    relay('sleep', 'session-sleep');
    relay('wake', 'session-wake');

    // Worktree lifecycle -> control WS, so the dashboard reflects the review/merge state and any
    // blocker (e.g. the integration branch missing) without re-fetching a full snapshot.
    sess.on('merge-status', ({ mergeStatus, reason, parked }) => {
      broadcastControl({
        type: 'session-merge-status', id: sess.id, session: sess.name,
        mergeStatus, reason: reason || null, parked: !!parked, timestamp: Date.now(),
      });
      // A merge/discard clears the worktree (isWorktree flips) but refreshGitContext can't see the
      // change once worktreeDir is null, so push the badge state explicitly here.
      broadcastControl({ type: 'session-git', id: sess.id, worktree: !!sess.isWorktree });
    });
    // The worktree changed (a commit/stage via the gitdir watch, a turn end, or the integration-ref
    // watcher caught an out-of-band / cross-session merge). Push a tiny delta signal; the client re-fetches the
    // full diff only for the session it is currently viewing (request-session-diff), so the heavy
    // `git diff` stays scoped. This is what replaces the old manual "Refresh diff" button.
    sess.on('worktree-changed', ({ sig }) => {
      broadcastControl({ type: 'session-changed', id: sess.id, sig });
    });
    sess.on('worktree-blocked', ({ branch, notice }) => {
      broadcastControl({
        type: 'session-worktree-blocked', id: sess.id, session: sess.name,
        branch, notice, timestamp: Date.now(),
      });
    });
    sess.on('worktree-ready', ({ branch }) => {
      broadcastControl({
        type: 'session-worktree-ready', id: sess.id, session: sess.name,
        branch, timestamp: Date.now(),
      });
      // Provision flips isWorktree true directly (sessions.js _provisionWorktree), so the health-poll
      // refreshGitContext never sees a false->true transition and never emits the badge delta. Push it
      // here, mirroring the merge-status handler, so the worktree badge turns on for a freshly spawned
      // worktree without waiting for a page reload.
      broadcastControl({ type: 'session-git', id: sess.id, worktree: !!sess.isWorktree });
      // Watch the integration branch's reflog so a cross-session / out-of-band merge into it re-checks
      // this (and every sibling) worktree's merge gate, with no poll. commonGitDir is set on the session
      // before this event fires (in _provisionWorktree).
      integrationPool.ensure(sess);
    });

    // On an in-place restart (restart()/forceRestart()/sleep-kill auto-restart) the
    // session's monotonic output offset resets to 0 (sessions.js start()). Any LIVE
    // data-WS client's ws-sender.sentOffset is now stale-high, which would silently
    // disable its in-place backfill until the client happens to reconnect. Force-close
    // those clients so they auto-reconnect (terminal.js) and re-baseline startOffset
    // through the connect path above. Server-only; the client is unchanged. Harmless
    // no-op when no data clients are attached (e.g. the first start()).
    sess.on('rebaseline', () => closeSessionDataClients(sess.id));
  }

  // Sessions are constructed dormant - no PTY spawns on boot. The user starts
  // a session on demand by expanding its chip from the minimized bar, which
  // sends a `start-session` control message.
  for (const project of config.projects) {
    const sess = makeSession(project, config);
    sessions.set(project.id, sess);
    wireSessionEvents(sess);
  }

  // Reconcile the on-disk session worktrees a prior run/crash/shutdown left behind (decision table and
  // rationale on reconcileSessionWorktrees). Once per distinct repo root, best-effort.
  try {
    // One-shot cold reconcile at boot (before any live session streams): use the SYNCHRONOUS engine
    // sibling so this blocking pass steals no PTY time from running sessions and never awaits. The live
    // async `gitWorkspace` is reserved for the recurring session/orchestrator paths.
    reconcileSessionWorktrees({
      projects: config.projects,
      sessions,
      gitWorkspaceSync: createGitWorkspaceSync(),
      integrationBranch: config.integrationBranch || 'develop',
      // adopt sets commonGitDir; watch the integration branch for this re-adopted worktree too
      onAdopt: (sess) => integrationPool.ensure(sess),
    });
  } catch (err) {
    console.warn(`[worktree] worktree reconcile failed: ${err.message}`);
  }

  // Smart auto-resume (design C): sessions active when Glissa last shut down come back with
  // their live Claude conversation resumed. Runs after worktree reconciliation, so a re-adopted
  // pending-review worktree is already in place before the session spawns into it. Fire-and-
  // forget: boot does not block on PTY spawns finishing (matches _addNewSessions' sess.start()).
  runAutoResume(sessions, config, spawnGate);

  // --- GitHub PR auto-review poller (opt-in; inert unless config.prReview.enabled) ---
  prReview.startPoller();

  function diffProjects(currentSessions, newProjects) {
    ensureProjectIds(newProjects);
    const newMap = new Map(newProjects.map(p => [p.id, p]));
    const added = [], removed = [], modified = [], renamed = [], unchanged = [];

    for (const [id, sess] of currentSessions) {
      // Ephemeral setup sessions are not config-backed; never add/remove/rename them on a reload.
      if (sess.ephemeral) continue;
      if (!newMap.has(id)) {
        removed.push(id);
        continue;
      }
      const newP = newMap.get(id);
      const pathChanged = newP.path !== sess.path;
      const permsChanged = projectSkipPerms(newP) !== sess.dangerouslySkipPermissions;
      if (pathChanged || permsChanged) {
        modified.push(newP);
        continue;
      }
      if (newP.name !== sess.name) {
        renamed.push(newP);
        continue;
      }
      unchanged.push(id);
    }
    for (const [id, proj] of newMap) {
      if (!currentSessions.has(id)) {
        added.push(proj);
      }
    }
    return { added, removed, modified, renamed, unchanged };
  }

  // Full teardown for one live session id: close its data clients, ack notifications, destroy the
  // Session (kills the PTY + cleans hooks), drop it from the map, and tell the dashboard. Returns
  // false if the id wasn't in the map. INVARIANT: acknowledge BEFORE destroy - destroy() calls
  // removeAllListeners(), which would pre-empt the notification/exit cleanup.
  function _teardownSession(id, logLabel) {
    const sess = sessions.get(id);
    if (!sess) return false;
    closeSessionDataClients(id);
    notificationManager.acknowledge(id);
    integrationPool.release(sess);
    sess.destroy();
    // Explicit removal -> throw the worktree away (junction-safe), but only AFTER destroy() has killed the
    // PTY and its reap settles: `git worktree remove --force` fails while the live process still holds the
    // worktree as its cwd (Windows directory lock), which used to leak the worktree AND its branch (the
    // follow-up `branch -D` then fails because the branch is still checked out), so a same-named re-add hit
    // "session branch already checked out". Shutdown/restart go through destroy() WITHOUT discard, so a
    // pending-review worktree survives for the next-boot reconcile.
    Promise.resolve(sess._killReap).catch(() => {}).then(() => sess.discardWorktree?.()).catch(() => { /* best-effort */ });
    sessions.delete(id);
    broadcastControl({ type: 'session-removed', id, session: sess.name });
    console.log(`${logLabel}: ${sess.name}`);
    return true;
  }

  function _removeOldSessions(removed) {
    for (const id of removed) {
      _teardownSession(id, '[config] Removed session');
    }
  }

  function _addNewSessions(added, newConfig) {
    for (const project of added) {
      const sess = makeSession(project, { ...config, ...newConfig });
      sessions.set(project.id, sess);
      wireSessionEvents(sess);
      // Broadcast BEFORE start(): sess.start() emits state-change synchronously,
      // and handleStateChange creates a card if one doesn't exist yet - without
      // skipPerms (state-change messages don't carry it), dropping the YOLO badge.
      broadcastControl({ type: 'session-added', id: project.id, session: project.name, path: project.path, state: sess.state, skipPerms: !!sess.dangerouslySkipPermissions, worktree: !!sess.isWorktree, resumeSessionId: sess.resumeSessionId || null });
      sess.start();
      console.log(`[config] Added session: ${project.name}`);
    }
  }

  function _modifyChangedSessions(modified, newConfig) {
    for (const project of modified) {
      const oldSess = sessions.get(project.id);
      closeSessionDataClients(project.id);
      // INVARIANT: acknowledge BEFORE destroy - destroy() calls removeAllListeners()
      notificationManager.acknowledge(project.id);
      integrationPool.release(oldSess);
      oldSess.destroy();
      const newSess = makeSession(project, { ...config, ...newConfig });
      sessions.set(project.id, newSess);
      // Wire listeners BEFORE the carry-over: adoptWorktree emits merge-status synchronously, and an
      // unwired emit is dropped, leaving open dashboards merge-clean while the server holds
      // pending-review (the boot reconcile wires-then-adopts in this same order).
      wireSessionEvents(newSess);
      carryWorktreeAcrossRecreate(oldSess, newSess);
      // adopt (same path) sets commonGitDir; watch the integration ref for the carried worktree too.
      if (newSess.worktreeDir) integrationPool.ensure(newSess);
      // Broadcast BEFORE start() - see _addNewSessions for rationale.
      broadcastControl({ type: 'session-modified', id: project.id, session: project.name, path: project.path, state: newSess.state, skipPerms: !!newSess.dangerouslySkipPermissions, worktree: !!newSess.isWorktree, resumeSessionId: newSess.resumeSessionId || null });
      newSess.start();
      console.log(`[config] Modified session: ${project.name}`);
    }
  }

  function _renameChangedSessions(renamed) {
    for (const project of renamed) {
      const sess = sessions.get(project.id);
      const oldName = sess.name;
      sess.name = project.name;
      broadcastControl({ type: 'session-renamed', id: project.id, oldName, newName: project.name });
      console.log(`[config] Renamed session: ${oldName} → ${project.name}`);
    }
  }

  function applyConfigReload(newConfig) {
    // ensureProjectIds mints a fresh random id for any id-less project. On the reload path that runs
    // against a freshly-read disk config, an id-less project would get a NEW id every reload and be
    // reclassified removed+added each time (=> a sess.start() respawn storm). Persist the assigned ids
    // back so the next read is stable; the per-process self-write guard suppresses the resulting watch.
    const assigned = ensureProjectIds(newConfig.projects);
    const diff = diffProjects(sessions, newConfig.projects);
    _removeOldSessions(diff.removed);
    _addNewSessions(diff.added, newConfig);
    _modifyChangedSessions(diff.modified, newConfig);
    _renameChangedSessions(diff.renamed);
    config.projects = newConfig.projects;
    applySettingsReload(newConfig);
    if (assigned) {
      try {
        configStore.save((fresh) => { fresh.projects = newConfig.projects; });
      } catch (err) {
        console.warn(`[config] Failed to persist assigned project IDs on reload: ${err.message}`);
      }
    }
  }

  function applySettingsReload(newConfig) {
    configStore.applySettings(newConfig);
    for (const [, sess] of sessions) {
      sess.updateSettings(config);
    }
    notificationManager.updateSettings({
      escalationIntervalMs: ESCALATION_INTERVAL_MS,
      debounceMs: config.notifyDebounceMs || 3000,
    });
    // No-op unless this save actually changed config.prReview/telegram; the restart itself is
    // serialized and drains in-flight reviews (see pr-review-wiring.js).
    prReview.restartIfConfigChanged();
  }

  // Restart/shutdown handlers live in server-lifecycle.js so the re-entry guard, the reap-before-exit
  // ordering, and the detached-respawn flags (windowsHide!) are unit-testable. shutdown() returns the
  // in-flight PTY reaps the lifecycle awaits before exit/respawn so the old PTY tree never orphans.
  // onRestart differs by mode: dev (Vite) restarts in-process; production (null) respawns detached.
  const { requestShutdown, requestRestart } = createLifecycle({
    shutdown,
    httpServer,
    onRestart: options.onRestart || null,
    spawn,
  });

  // Latest startup update-check result, cached so a control client connecting AFTER the check resolves
  // still gets the update-available replay (see the connection handler in control-handlers.js).
  let updateStatus = null;
  const getUpdateStatus = () => updateStatus;
  // Abort handle for the in-flight startup registry request, so shutdown can cancel it instead of
  // waiting out its timeout (see shutdown() and the update-check kickoff at the end of the factory).
  const updateAbort = new AbortController();

  registerControlHandlers(controlWss, {
    sessions,
    config,
    configStore,
    broadcastControl,
    controlReplayLog,
    generateProjectId,
    makeSession,
    wireSessionEvents,
    applyConfigReload,
    applySettingsReload,
    requestShutdown,
    requestRestart,
    handleClientFocus,
    buildHealthSnapshot,
    getUpdateStatus,
    registry,
    orchestrator,
    scheduler: { reload: armTeamSchedules },
    teamOutput,
    getProjectPathById,
    openInEditor,
    startPackSetup,
    // Ephemeral sessions (guided pack setup) are not config-backed, so the remove-session
    // handler can't go through the config-reload diff path; give it a direct teardown.
    removeEphemeralSession: (id) => _teardownSession(id, '[control] Removed session via UI'),
  });

  // --- Data WebSocket ---

  dataWss.on('connection', (ws, req) => {
    const parts = req.url.split('/');
    let sessionId;
    try {
      sessionId = decodeURIComponent(parts[parts.length - 1]);
    } catch {
      ws.close(1008, 'Invalid session id');
      return;
    }
    const sess = getSessionAny(sessionId);

    if (!sess) {
      ws.close(1008, 'Session not found');
      return;
    }

    if (!sessionDataClients.has(sessionId)) {
      sessionDataClients.set(sessionId, new Set());
    }
    sessionDataClients.get(sessionId).add(ws);

    // Backpressure-aware, echo-prioritizing sender (see ws-sender.js): coalesces
    // PTY frames into fewer/larger WS frames, SKIPS sends when the socket is
    // backed up (the bytes stay in the session ring buffer and replay on
    // reconnect, so RSS is bounded by construction), closes a wedged client past
    // a stall timeout, and flushes the echo frame immediately after user input.
    // Created before the replay send so the replay shares the same high-water guard.
    // Capture the replay snapshot and the live baseline offset atomically - same
    // synchronous tick, before 'data' is wired below, so no 'data' event can slip in
    // between. The replay covers [base, total); startOffset = total; live onData resumes
    // exactly at total (no overlap, no gap). The injected source lets the sender recover
    // bytes dropped under backpressure in place, without a reconnect (ws-sender.js).
    const replay = sess.getReplayBuffer();
    const startOffset = sess.getOutputOffset();
    const sender = createWsSender(ws, {
      source: { getBufferSince: (off) => sess.getBufferSince(off) },
      startOffset,
    });
    if (replay) {
      // sendImmediate runs here on a FRESH socket (bufferedAmount 0), so its backpressure
      // drop branch is normally unreachable. If that assumption ever breaks, ws-sender
      // rewinds sentOffset to the replay base and logs loudly so the regression surfaces.
      sender.sendImmediate(replay);
    }

    const dataListener = (data) => sender.onData(data);
    sess.on('data', dataListener);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'input' && typeof msg.data === 'string') {
        if (msg.data.length > 16384) {
          console.warn(`[data-ws] Rejected oversized input (${msg.data.length} chars) for ${sess.name}`);
          broadcastControl({
            type: 'session-error',
            id: sess.id,
            session: sess.name,
            message: 'Paste too large - try pasting smaller chunks',
            timestamp: Date.now(),
          });
          return;
        }
        sess.write(msg.data);
        // Flush the next PTY frame after input (the echo) immediately instead of
        // holding it a tick behind coalesced bulk - still gated by the sender's
        // backpressure guard.
        sender.markInputFlush();
        if (sess.state === STATES.WAITING) {
          sess.transition('user_input');
        }
        return;
      }
      if (msg.type === 'resize') {
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        if (Number.isInteger(cols) && Number.isInteger(rows)
            && cols > 0 && cols <= 500 && rows > 0 && rows <= 200) {
          sess.resize(cols, rows);
        }
      }
    });

    ws.on('error', (err) => {
      const isPayload = err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
      const reason = isPayload
        ? 'Message too large - try pasting smaller chunks'
        : err.message;
      console.warn(`[data-ws] Error for ${sess.name}: ${err.message}`);
      broadcastControl({
        type: 'session-error',
        id: sess.id,
        session: sess.name,
        message: reason,
        timestamp: Date.now(),
      });
      // ws 'close' fires automatically after error - no need to call ws.close()
    });

    ws.on('close', () => {
      sess.removeListener('data', dataListener);
      sender.destroy();
      const clients = sessionDataClients.get(sessionId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) sessionDataClients.delete(sessionId);
      }
    });
  });

  // --- WebSocket upgrade routing ---
  // Node's 'upgrade' event fires for ALL listeners. We only handle paths
  // we own (/control, /terminals/*). Unrecognized paths are left alone so
  // other listeners (e.g. Vite HMR) can handle them.

  httpServer.on('upgrade', (req, socket, head) => {
    const { url } = req;

    if (url === '/control') {
      if (!isAllowedOrigin(req)) { socket.destroy(); return; }
      controlWss.handleUpgrade(req, socket, head, (ws) => {
        controlWss.emit('connection', ws, req);
      });
      return;
    }
    if (url.startsWith('/terminals/')) {
      if (!isAllowedOrigin(req)) { socket.destroy(); return; }
      dataWss.handleUpgrade(req, socket, head, (ws) => {
        dataWss.emit('connection', ws, req);
      });
    }
    // No else - let other upgrade listeners (Vite HMR) handle their paths
  });

  // --- Config hot-reload ---

  const stopConfigWatch = configStore.watchForChanges((newConfig) => {
    applyConfigReload(newConfig);
  });

  // --- Shutdown ---

  let shuttingDown = false;

  function shutdown() {
    if (shuttingDown) return [];
    shuttingDown = true;
    clearInterval(healthInterval);
    stopConfigWatch();
    try { updateAbort.abort(); } catch { /* no in-flight update request */ }
    // INVARIANT: destroy NotificationManager BEFORE sessions - clears all timers globally
    notificationManager.destroy();
    for (const [, s] of teamSchedulers) s.disarm();
    integrationPool.stopAll();
    // Collect each session's in-flight PTY reap (set by kill() on win32, see sessions.js) so the
    // lifecycle can await them before exit/respawn; a DORMANT session has no PTY and no reap.
    const pendingReaps = [];
    for (const [, sess] of sessions) {
      sess.destroy();
      if (sess._killReap) pendingReaps.push(sess._killReap);
    }
    for (const [, sess] of teamSessions) {
      sess.destroy();
      if (sess._killReap) pendingReaps.push(sess._killReap);
    }
    // Blocks a restart still queued on the poller's restart chain (e.g. a settings save that raced
    // shutdown) from starting a fresh poller after the process has begun tearing down.
    prReview.stopPoller();
    for (const [, sess] of reviewSessions) {
      sess.destroy();
      if (sess._killReap) pendingReaps.push(sess._killReap);
    }
    controlWss.close();
    dataWss.close();
    return pendingReaps;
  }

  // --- Startup update check ---
  // Fire-and-forget: NEVER awaited, so a slow/hung registry can't delay boot. The terminal .catch is
  // load-bearing - surface() calls console.log + broadcastControl, and this process has no
  // uncaughtException handler, so a throw here would become an unhandledRejection that crashes it.
  // Primary dev-nag guard is the version compare itself (a dev at/ahead of latest never triggers a
  // banner); isLocalConfig is a best-effort secondary skip. checkForUpdate is injectable so a boot
  // test can drive it with a stub instead of hitting the network.
  const runUpdateCheck = options.checkForUpdate || defaultCheckForUpdate;
  function surfaceUpdate(result) {
    if (!result || !result.updateAvailable) return;
    updateStatus = result;
    console.log(`[update] A newer glissa is available: ${result.current} -> ${result.latest}. Update: ${result.command}`);
    broadcastControl({ type: 'update-available', ...result });
  }
  if (config.checkForUpdates !== false && !configStore.isLocalConfig) {
    const currentVersion = require('../package.json').version;
    runUpdateCheck({ currentVersion, abortController: updateAbort })
      .then(surfaceUpdate)
      .catch(() => { /* advisory only - never let the update check affect the process */ });
  }

  return { shutdown, port, app };
}

/**
 * Mount dev-mode fallback routes for serving xterm.js and shared modules
 * directly from node_modules. Only used in production when dist/ doesn't exist.
 */
function mountDevRoutes(app) {
  app.get('/xterm/xterm.css', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'node_modules/@xterm/xterm/css/xterm.css'));
  });
  app.get('/xterm/xterm.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, '..', 'node_modules/@xterm/xterm/lib/xterm.mjs'));
  });
  app.get('/xterm/addon-fit.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, '..', 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs'));
  });
  app.get('/xterm/addon-webgl.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, '..', 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'));
  });

  app.get('/shared/states.mjs', (_req, res) => {
    const states = require('../shared/states');
    const lines = [];
    for (const [key, val] of Object.entries(states)) {
      lines.push(`export const ${key} = ${JSON.stringify(val)};`);
    }
    res.type('application/javascript');
    res.send(lines.join('\n'));
  });
}

module.exports = {
  createBackend, runAutoResume, persistSessionField, decideWasActiveFlip, carryWorktreeAcrossRecreate,
  reconcileSessionWorktrees,
};
