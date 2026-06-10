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
const { Session } = require('./sessions');
const { STATES } = require('./shared/states');
const { createConfigStore, generateProjectId, ensureProjectIds, DEFAULT_CONFIG } = require('./config-store');
const { registerControlHandlers } = require('./control-handlers');
const { NotificationManager } = require('./notification-manager');
const { createToastChannel } = require('./channels/toast');
const { createWebNotificationChannel } = require('./channels/web-notification');
const { createRecorder } = require('./session-recorder');
const { createWsSender } = require('./ws-sender');
const { HookRouter } = require('./detection/hook-source');
const { sweepOrphans } = require('./detection/settings-injector');
const { spawn } = require('node:child_process');
const { loadTeam, listTeams } = require('./teamlib/team-registry');
const { createOrchestrator } = require('./teamlib/team-orchestrator');
const { createScheduler } = require('./scheduler');
const { createSpawnGate } = require('./spawn-gate');
const { createGitWorkspace } = require('./teamlib/team-git');
const { buildStageSpawnOptions, teamPermissions } = require('./teamlib/team-settings');
const { buildStagePrompt } = require('./teamlib/team-prompt');
const { buildSetupPrompt, setupSessionId, setupSessionName, packPaths } = require('./teamlib/team-setup');
const { scanProjectContext } = require('./teamlib/project-context');
const teamOutput = require('./teamlib/team-output');
const { runPostTurnChecks, resolveCheckConfig } = require('./post-turn-checker');
const { createIntegrationRefWatcher } = require('./detection/integration-ref-watch');
const { createIntegrationWatcherPool } = require('./detection/integration-watcher-pool');

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
    const addr = httpServer && httpServer.address();
    return addr && typeof addr === 'object' && addr.port ? addr.port : null;
  };
  // Clear settings dirs orphaned by prior crashes (best-effort).
  try { sweepOrphans(); } catch { /* ignore */ }

  // Optional LLM proxy (config proxyBaseUrl -> ANTHROPIC_BASE_URL in the spawn env). A GETTER, not
  // a snapshot: applySettings mutates `config` in place, so a settings change reaches every session
  // on its next PTY (re)spawn without rebuilding Session objects. Shared by user, team-stage, and
  // pack-setup sessions so "point everything at the proxy" really means everything.
  const getProxyBaseUrl = () => config.proxyBaseUrl ?? '';

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
      getProxyBaseUrl,
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
    });
    const recorder = createRecorder(project.name, cfg.capture);
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
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) { aborted = true; req.destroy(); }
    });
    req.on('end', () => {
      if (aborted) return;
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { /* tolerate */ }
      const token =
        (req.query && req.query.t) ||
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
    const distPath = path.join(__dirname, 'dist');
    const useDistDir = fs.existsSync(distPath) && fs.statSync(distPath).isDirectory();
    const resolvedDir = useDistDir ? 'dist' : 'public';
    app.use(express.static(path.join(__dirname, resolvedDir)));

    if (!useDistDir) {
      mountDevRoutes(app);
    }
  } else if (typeof staticDir === 'string') {
    app.use(express.static(staticDir));
  }
  // staticDir === null: skip all static serving (Vite mode)

  // --- WebSocket servers (noServer mode) ---

  const controlWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const dataWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  function broadcastControl(msg) {
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
    for (const sess of [...sessions.values(), ...teamSessions.values()]) {
      const stats = sess.getHealthStats();
      stats.detection = sess.getDetectionStats();
      stats.ephemeral = !!sess.ephemeral;
      sessionStats.push(stats);
      if (stats.hasPty) alivePtyCount++;
      if (stats.sleeping) sleepingCount++;
      totalDataListeners += stats.dataListenerCount;
      totalOutputBufferBytes += stats.outputBufferBytes;
      // Anomaly checks assume a persisted session with tracked data-WS clients and a stable
      // lifecycle. Ephemeral team-stage sessions stream transiently and tear down fast, so they are
      // excluded to avoid false-positive listenerMismatch/orphanPty during a run.
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
    if (focused) {
      focusedClients.add(ws);
    } else {
      focusedClients.delete(ws);
    }
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

  const TEAMS_DIR = path.join(__dirname, 'teams');
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
        spawn(full, { detached: true, stdio: 'ignore', shell: true, windowsHide: true }).unref();
      } else if (process.platform === 'win32') {
        // `start` is a cmd builtin; the empty "" is its window-title arg so a quoted path isn't taken as the title.
        spawn('cmd', ['/c', 'start', '', absPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [absPath], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [absPath], { detached: true, stdio: 'ignore' }).unref();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Build a real Session for one team stage, registered in teamSessions and auto-removed on end.
  function makeStageSession({ id, name, path: projectPath, initialPrompt, spawnOptions, permissions }) {
    const sess = new Session({
      id,
      name,
      path: projectPath,
      dangerouslySkipPermissions: !!spawnOptions?.dangerouslySkipPermissions,
      extraClaudeArgs: spawnOptions?.extraClaudeArgs || [],
      initialPrompt,
      ephemeral: true,
      settingsPermissions: permissions || null,
      replayBufferKB: config.replayBufferKB,
      hookRouter,
      getHookPort,
      getProxyBaseUrl,
    });
    teamSessions.set(id, sess);
    sess.on('error', (err) => console.error(`[team ${name}] error: ${err.message}`));
    // Stage sessions run headless (claude -p) and produce no watchable TUI, so they are NOT surfaced
    // as terminal cards (that just shows an empty terminal). Run progress lives in the Teams view
    // pipeline; these sessions stay out of the session-card broadcast stream entirely.
    const removeFromMap = () => {
      if (teamSessions.get(id) === sess) {
        teamSessions.delete(id);
        closeSessionDataClients(id);
      }
    };
    sess.on('exit', removeFromMap);
    // destroy() runs in every orchestrator finish path (success/timeout/cancel) and removeAllListeners
    // there can pre-empt the 'exit' cleanup, so wrap destroy to guarantee map removal.
    const origDestroy = sess.destroy.bind(sess);
    sess.destroy = () => { origDestroy(); removeFromMap(); };
    return sess;
  }

  // Guided pack setup. Spawn ONE interactive Claude session (a normal PTY session, surfaced as a
  // terminal card) seeded with a prompt that interviews the operator and fills this project's pack.
  // Unlike a team stage it is NOT headless (the interview needs back-and-forth) and IS shown as a
  // card so the operator can answer in the terminal. It lives in the regular `sessions` map but is
  // flagged ephemeral (skips config-reload diffing and health anomaly checks) and is never persisted
  // to config.json. On exit we re-check the pack and broadcast team-pack-status so the Teams view
  // drops its setup banner. Returns { ok, sessionId, already?, error? }.
  function startPackSetup({ teamId, projectId }) {
    let team;
    try { team = registry.loadTeam(teamId); } catch { return { ok: false, error: `Unknown team "${teamId}"` }; }
    const projectPath = getProjectPathById(projectId);
    if (!projectPath) return { ok: false, error: 'Unknown project' };

    const id = setupSessionId(teamId, projectId);
    if (sessions.has(id)) return { ok: true, already: true, sessionId: id };

    // Make sure the pack files exist (idempotent) so the agent has templates to fill in place. Shared
    // files (team.packShared) scaffold into the project-level .glissa/pack/ from the _shared fallback
    // templates; a pre-filled team-local copy of a now-shared file is promoted up here too.
    teamOutput.ensureStructure(projectPath, team.outputPath);
    teamOutput.scaffoldPack(
      projectPath, team.outputPath, team.packTemplatesDir, team.packRequired,
      team.packTemplatesFallbackDir, team.packShared,
    );
    const { packDir, sharedPackDir, packFiles } = packPaths(projectPath, team);
    // Interview ONLY the files that still need filling, so an already-filled shared file (filled by an
    // earlier team's setup) is skipped instead of re-asked. A fresh project has every file unfilled, so
    // toFill == packFiles and the prompt is unchanged from before this feature.
    const status = teamOutput.packStatus(projectPath, team.outputPath, team.packRequired, team.packShared);
    const unfilled = new Set(status.unfilled);
    const toFill = packFiles.filter((f) => unfilled.has(f.name));
    // Deterministic project-context scan (total, never throws); an empty summary degrades to the
    // original prompt with no STARTING FACTS block.
    const projectContext = scanProjectContext(projectPath).summary;
    const prompt = buildSetupPrompt(team, {
      packDir, sharedPackDir, packFiles: toFill, projectPath, projectContext,
    });

    const projectDisplayName = (config.projects.find((p) => p.id === projectId) || {}).name || '';
    const name = setupSessionName(team, projectDisplayName);

    const sess = new Session({
      id,
      name,
      path: projectPath,
      // Interactive (no -p): the prompt is submitted as the first message and the operator keeps
      // typing. Writes to the pack are approved in the terminal; the team deny-list is applied as a
      // belt-and-suspenders guard via the injected settings file.
      dangerouslySkipPermissions: false,
      initialPrompt: prompt,
      ephemeral: true,
      settingsPermissions: teamPermissions(team),
      replayBufferKB: config.replayBufferKB,
      hookRouter,
      getHookPort,
      getProxyBaseUrl,
    });
    sessions.set(id, sess);
    wireSessionEvents(sess);
    // Surface as a card (same shape the config-reload add path broadcasts).
    broadcastControl({ type: 'session-added', id, session: name, state: sess.state, skipPerms: false, ephemeral: true });

    sess.on('exit', () => {
      let st = null;
      try { st = teamOutput.packStatus(projectPath, team.outputPath, team.packRequired, team.packShared); } catch { /* report nothing */ }
      if (st) {
        // Distinct from the team-pack-status request REPLY so it never collides with a get-team-pack-
        // status round-trip; the Teams view routes this broadcast to refresh the setup banner.
        broadcastControl({
          type: 'team-pack-updated', teamId, projectId,
          configured: st.configured, unfilled: st.unfilled, packDir: st.packDir,
          timestamp: Date.now(),
        });
      }
      if (sessions.get(id) === sess) {
        sessions.delete(id);
        closeSessionDataClients(id);
      }
      broadcastControl({ type: 'session-removed', id, session: name });
    });
    sess.start();
    return { ok: true, sessionId: id };
  }

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

    sess.on('state-change', ({ from, to, event }) => {
      broadcastControl({
        type: 'state-change',
        id: sess.id,
        session: sess.name,
        from, to, event,
        timestamp: Date.now()
      });

      // Notification triggers: session state -> notification lifecycle. Both turn-complete (COMPLETE)
      // and process exit (DONE) notify under the 'complete' category so the two terminal "it finished"
      // states stay consistent; the per-session debounce coalesces a COMPLETE->DONE pair into one toast.
      if (to === STATES.WAITING) {
        notificationManager.trigger(sess.id, 'waiting', `${sess.name} needs your input`);
      } else if (to === STATES.COMPLETE || to === STATES.DONE) {
        notificationManager.trigger(sess.id, 'complete', `${sess.name} finished working`);
      } else if (to === STATES.FAILED) {
        notificationManager.trigger(sess.id, 'failed', `${sess.name} failed`);
      }

      // Acknowledge when leaving a notification-triggering state. DONE is included so a restart
      // (DONE -> INITIALIZING) clears the 'complete' entry a direct RUNNING->DONE exit left in
      // DELIVERED; without this the restarted session's next trigger is a no-op and it goes silent.
      if (from === STATES.WAITING || from === STATES.COMPLETE || from === STATES.DONE || from === STATES.FAILED) {
        notificationManager.acknowledge(sess.id);
      }
    });

    // Live background sub-agent count delta -> control WS, so the card shows "N agents" while a
    // background sub-agent keeps running after the main turn's Stop (instead of flipping to Complete).
    // Mirrors the session-git delta: a small targeted update, no full snapshot refetch.
    sess.on('agents-change', ({ activeAgents }) => {
      broadcastControl({
        type: 'session-agents',
        id: sess.id,
        session: sess.name,
        activeAgents,
        timestamp: Date.now(),
      });
    });

    // Pending scheduled-revival delta -> control WS, so a COMPLETE/IDLE card can say
    // "sleeping until ~HH:MM" instead of looking finished while a wakeup is pending.
    // Advisory only (never gates a transition); mirrors the session-agents delta.
    sess.on('wakeup-change', ({ pendingWakeup }) => {
      broadcastControl({
        type: 'session-wakeup',
        id: sess.id,
        session: sess.name,
        pendingWakeup,
        timestamp: Date.now(),
      });
    });

    sess.on('sleep', () => {
      broadcastControl({
        type: 'session-sleep',
        id: sess.id,
        session: sess.name,
        timestamp: Date.now()
      });
    });

    sess.on('wake', () => {
      broadcastControl({
        type: 'session-wake',
        id: sess.id,
        session: sess.name,
        timestamp: Date.now()
      });
    });

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

  // Reconcile on-disk session worktrees left by a prior run/crash: a worktree whose session still exists
  // and holds UNMERGED work is re-adopted (resurfaced as pending-review, so the operator can still
  // review/merge or resume it); anything else (a clean orphan, or a worktree for a since-deleted session)
  // is removed junction-safe. This is what makes cleanup correct regardless of how a session ended: no
  // data loss, no leaked worktrees. Once per distinct repo root, best-effort.
  try {
    const reconciledRoots = new Set();
    const integrationBranch = config.integrationBranch || 'develop';
    for (const project of config.projects) {
      if (!project.path || reconciledRoots.has(project.path)) continue;
      reconciledRoots.add(project.path);
      for (const wt of gitWorkspace.listSessionWorktrees({ projectPath: project.path, integrationBranch })) {
        const sess = sessions.get(wt.id);
        if (sess && wt.hasWork) {
          sess.adoptWorktree({ worktreeDir: wt.cwd, branch: wt.branch, base: integrationBranch });
          integrationPool.ensure(sess); // adopt sets commonGitDir; watch the branch for this re-adopted worktree too
          console.log(`[worktree] re-adopted pending-review worktree for ${sess.name} (${wt.branch})`);
        } else {
          gitWorkspace.removeWorktreeByPath({ projectPath: project.path, cwd: wt.cwd, branch: wt.branch });
        }
      }
    }
  } catch (err) {
    console.warn(`[worktree] worktree reconcile failed: ${err.message}`);
  }

  function diffProjects(currentSessions, newProjects) {
    ensureProjectIds(newProjects);
    const newMap = new Map(newProjects.map(p => [p.id, p]));
    const added = [], removed = [], modified = [], renamed = [], unchanged = [];

    for (const [id, sess] of currentSessions) {
      // Ephemeral setup sessions are not config-backed; never add/remove/rename them on a reload.
      if (sess.ephemeral) continue;
      if (newMap.has(id)) {
        const newP = newMap.get(id);
        const pathChanged = newP.path !== sess.path;
        const permsChanged = projectSkipPerms(newP) !== sess.dangerouslySkipPermissions;
        if (pathChanged || permsChanged) {
          modified.push(newP);
        } else if (newP.name !== sess.name) {
          renamed.push(newP);
        } else {
          unchanged.push(id);
        }
      } else {
        removed.push(id);
      }
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
    // Explicit removal -> throw the worktree away (junction-safe). Shutdown/restart go through destroy()
    // directly and do NOT discard, so a pending-review worktree survives for the next-boot reconcile.
    try { sess.discardWorktree?.(); } catch { /* best-effort */ }
    integrationPool.release(sess);
    sess.destroy();
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
      broadcastControl({ type: 'session-added', id: project.id, session: project.name, path: project.path, state: sess.state, skipPerms: !!sess.dangerouslySkipPermissions, worktree: !!sess.isWorktree });
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
      wireSessionEvents(newSess);
      // Broadcast BEFORE start() - see _addNewSessions for rationale.
      broadcastControl({ type: 'session-modified', id: project.id, session: project.name, path: project.path, state: newSess.state, skipPerms: !!newSess.dangerouslySkipPermissions, worktree: !!newSess.isWorktree });
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
    ensureProjectIds(newConfig.projects);
    const diff = diffProjects(sessions, newConfig.projects);
    _removeOldSessions(diff.removed);
    _addNewSessions(diff.added, newConfig);
    _modifyChangedSessions(diff.modified, newConfig);
    _renameChangedSessions(diff.renamed);
    config.projects = newConfig.projects;
    applySettingsReload(newConfig);
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
  }

  function requestShutdown() {
    shutdown();
    httpServer.close(() => {
      console.log('Server closed - exiting.');
      process.exit(0);
    });
    // Fallback: if close callback doesn't fire within 2s, force exit
    setTimeout(() => process.exit(0), 2000);
  }

  // requestRestart is provided by the caller (Vite plugin or server.js)
  // since restart behavior differs between dev and production modes.
  const _onRestart = options.onRestart || null;

  function requestRestart() {
    shutdown();
    if (_onRestart) {
      _onRestart();
    } else {
      // Fallback: restart by spawning a new process.
      // Close the HTTP server first so the port is released cleanly,
      // then spawn the replacement and exit.
      let spawned = false;
      const spawnAndExit = () => {
        if (spawned) return;
        spawned = true;
        const { spawn } = require('node:child_process');
        spawn(process.argv[0], process.argv.slice(1), {
          cwd: process.cwd(),
          stdio: 'ignore',
          detached: true,
        }).unref();
        process.exit(0);
      };
      httpServer.close(spawnAndExit);
      // Fallback: if close callback doesn't fire within 2s, force it
      setTimeout(spawnAndExit, 2000);
    }
  }

  registerControlHandlers(controlWss, {
    sessions,
    config,
    configStore,
    broadcastControl,
    generateProjectId,
    makeSession,
    wireSessionEvents,
    applyConfigReload,
    applySettingsReload,
    requestShutdown,
    requestRestart,
    handleClientFocus,
    buildHealthSnapshot,
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
      } else if (msg.type === 'resize') {
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
    } else if (url.startsWith('/terminals/')) {
      if (!isAllowedOrigin(req)) { socket.destroy(); return; }
      dataWss.handleUpgrade(req, socket, head, (ws) => {
        dataWss.emit('connection', ws, req);
      });
    }
    // No else - let other upgrade listeners (Vite HMR) handle their paths
  });

  // --- Config hot-reload ---

  configStore.watchForChanges((newConfig) => {
    applyConfigReload(newConfig);
  });

  // --- Shutdown ---

  let shuttingDown = false;

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(healthInterval);
    // INVARIANT: destroy NotificationManager BEFORE sessions - clears all timers globally
    notificationManager.destroy();
    for (const [, s] of teamSchedulers) s.disarm();
    integrationPool.stopAll();
    for (const [, sess] of sessions) {
      sess.destroy();
    }
    for (const [, sess] of teamSessions) {
      sess.destroy();
    }
    controlWss.close();
    dataWss.close();
  }

  return { shutdown, port, app };
}

/**
 * Mount dev-mode fallback routes for serving xterm.js and shared modules
 * directly from node_modules. Only used in production when dist/ doesn't exist.
 */
function mountDevRoutes(app) {
  app.get('/xterm/xterm.css', (_req, res) => {
    res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'));
  });
  app.get('/xterm/xterm.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.mjs'));
  });
  app.get('/xterm/addon-fit.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs'));
  });
  app.get('/xterm/addon-webgl.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'));
  });

  app.get('/shared/states.mjs', (_req, res) => {
    const states = require('./shared/states');
    const lines = [];
    for (const [key, val] of Object.entries(states)) {
      lines.push(`export const ${key} = ${JSON.stringify(val)};`);
    }
    res.type('application/javascript');
    res.send(lines.join('\n'));
  });
}

module.exports = { createBackend };
