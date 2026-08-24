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

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Session } = require('../session/sessions');
const { resolveAdapter } = require('../session/adapters');
const { STATES } = require('../shared/states');
const { isSameDirectoryPath } = require('../shared/paths');
const { createConfigStore, generateProjectId, ensureProjectIds, DEFAULT_CONFIG } = require('./config-store');
const { registerControlHandlers } = require('./control-handlers');
const { createReplayLog } = require('./control-replay-core');
const { createLifecycle } = require('./server-lifecycle');
const { NotificationManager } = require('../notifications/notification-manager');
const { createNotifyGate, explainNotification } = require('../session/core/notify-gate');
const { pickAutoResume } = require('../session/core/auto-resume');
const { createTelegramChannel, decideTelegramNotification } = require('../notifications/channels/telegram');
const { createTelegramOutbox } = require('../notifications/telegram-outbox');
const { sendTelegramMessage } = require('./telegram-transport');
const { createToastChannel } = require('../notifications/channels/toast');
const { createWebNotificationChannel } = require('../notifications/channels/web-notification');
const { createRecorder } = require('../session/session-recorder');
const { createWsSender } = require('./ws-sender');
const { HookRouter } = require('../detection/hook-source');
const { sweepOrphans } = require('../detection/settings-injector');
const { getRtkPath } = require('../session/core/rtk-command');
const { checkForUpdate: defaultCheckForUpdate } = require('./update-check');
const { shortSha } = require('./core/update-core');
const { createSpawnGate } = require('./spawn-gate');
const { spawn } = require('./child-process-safe');
const { createGitWorkspace, createGitWorkspaceSync } = require('./git-workspace');
const { runPostTurnChecks, resolveCheckConfig } = require('./post-turn-checker');
const { createPrReviewWiring } = require('./pr-review-wiring');
const { createPosthogWiring } = require('./posthog-wiring');
const { createVisionsWiring } = require('./visions-wiring');
const { createVisionsDispatcher, createVisionsSpawn } = require('./visions-dispatch');
const { resolveVisionsConfig } = require('./core/visions-dispatch-core');
const { normalizeShapePath } = require('./core/visions-scope-core');
const { createIngestLane } = require('./ingest-wiring');
const { resolveIngestConfig } = require('./core/ingest-core');
const { createMemoryStore } = require('./memory-store');
const { DB_FILE_NAME } = require('./glissa-db');
const { createMemoryIngest, earliestLaneEntryMs } = require('./memory-ingest-wiring');
const { createMemoryDistillSpawn, createMemoryDistiller } = require('./memory-distill');
const { resolveMemoryConfig } = require('./core/memory-core');
const { resolveDistillConfig: resolveMemoryDistillConfig } = require('./core/memory-distill-core');
const { createUsageWiring, resolveUsageConfig } = require('./usage-wiring');
const { createLaneLedger } = require('./usage-lane-ledger');
const { INTERACTIVE_LANE } = require('./core/usage-lane-core');
const { normalizeRemoteConfig, validateRemoteConfig, decideBindHost } = require('./core/remote-config');
const { createClientPresence } = require('./core/client-presence');
const { decideControlSend } = require('./core/control-send-core');
const { createHeartbeat } = require('./ws-heartbeat');
const { consumedPackNames, normalizePackNames, packVariantProjects, projectVariantSlug } = require('./core/pack-core');
const { createPackService } = require('./pack-service');
const { createMillWiring } = require('./mill-wiring');
const {
  DEFAULT_INTERVAL_HOURS, DEFAULT_TIMEOUT_SECONDS, createDistillSpawn, createPackDistiller,
} = require('./pack-distiller');
const { classifyUpgradePath, dataSessionIdFromUrl, upgradeTokenFromUrl } = require('./core/upgrade-route');
const { classifyRequestOrigin, decideUpgradeAccess } = require('./core/request-trust');
const { decideHostAllowed } = require('./core/host-policy');
const { decideOriginAllowed, hostOfOrigin } = require('./core/origin-policy');
const { isApplicableViewerSize, pickSizeAfterDeparture } = require('./core/viewer-size-core');
const { createRemoteAuth } = require('./remote-auth');
const { createStopperCollector } = require('./core/shutdown-core');
const { configSiblingPath, createPairingsStore, createSeenStore, defaultPairingsPath, defaultSeenPath } = require('./pairings-store');
const {
  buildUploadFilename,
  decideUploadType,
  exceedsUploadCap,
  framePathPaste,
  isSafePathSegment,
  planUploadRetention,
} = require('./core/upload-core');

// WAITING-state notification escalation cadence (fixed 5 minutes; previously the
// configurable waitingEscalationSeconds setting).
const ESCALATION_INTERVAL_MS = 300000;

// Fallback for the escalation ladder's last rung when config.json names no phoneEscalationMs. Same
// five minutes, so an install that never touches the key behaves as it did.
const DEFAULT_PHONE_ESCALATION_MS = 300000;

// How often a running server rechecks the latest release after the boot check.
const UPDATE_RECHECK_MS = 24 * 60 * 60 * 1000;

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
// No-ops when the project is absent from cfg.projects (ephemeral lane sessions are never
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

// The id rides beside the path because scope and intent ownership are the same question asked twice:
// which project does this uri belong to.
function resolveVisionsScopeProjects(projectIds, projects, warn = console.warn) {
  if (!Array.isArray(projectIds) || projectIds.length === 0) return null;
  const projectsById = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || typeof project.id !== 'string') continue;
    projectsById.set(project.id, project);
  }
  const scopeProjects = [];
  for (const projectId of projectIds) {
    const project = projectsById.get(projectId);
    if (!project) {
      warn(`[visions] configured project id not found: ${projectId}`);
      continue;
    }
    const normalizedPath = normalizeShapePath(project.path);
    if (!normalizedPath) {
      warn(`[visions] configured project has no usable path: ${projectId}`);
      continue;
    }
    // Every pair is kept: two projects legitimately share one path (same repo, different sessions).
    scopeProjects.push({ id: projectId, path: normalizedPath });
  }
  if (scopeProjects.length === 0) return null;
  return scopeProjects;
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
// A DORMANT card was not running, so a record replace must not spawn it; live states keep recreate-and-restart.
function shouldStartAfterModify(previousState) {
  return previousState !== STATES.DORMANT;
}

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
//     would destroy uncommitted work. Left for manual review rather than swept.
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

// The one hook event whose response can inject context into the turn it answers. Case-insensitive to
// match mapHookToSignal, which reads the same route parameter.
function isUserPromptSubmitEvent(event) {
  return String(event || '').toLowerCase() === 'userpromptsubmit';
}

// Telemetry, not a status signal: mapHookToSignal returns null for it (so HookRouter answers 200 with
// no signal after validating the token exactly as it does for every other event), and the route hands
// the payload to the usage lane instead of the detection path.
function isStatuslineEvent(event) {
  return String(event || '').toLowerCase() === 'statusline';
}

function bootError(message) {
  const err = new Error(message);
  err.glissaBoot = true;
  return err;
}

function createBackend(httpServer, options = {}) {
  const { staticDir = 'auto', settingsDefaults } = options;

  // settingsDefaults is a per-launch fallback for keys config.json omits, never persisted (the dev
  // server defaults debugMode on that way). Production passes nothing and behaves as before.
  const configStore = createConfigStore({ settingsDefaults });
  const { config } = configStore;
  const port = process.env.GLISSA_PORT
    ? Number.parseInt(process.env.GLISSA_PORT, 10)
    : (config.port || 3000);

  // --- Remote mode (off unless config.remote.enabled) ---
  // Two listeners, one Express app. Trust is decided per request by which listener the socket landed
  // on, so nothing a client can send widens it. With remote disabled every branch below is inert and
  // the request/upgrade paths behave exactly as they did before (pinned by
  // tests/backend-remote-disabled.test.js).
  const remote = normalizeRemoteConfig(config.remote);
  const remoteCheck = validateRemoteConfig(remote, port);
  if (!remoteCheck.ok) throw bootError(`[remote] invalid configuration: ${remoteCheck.error}`);
  const insecureBind = process.env.GLISSA_INSECURE_BIND === '1';
  const bindDecision = decideBindHost({ envHost: process.env.GLISSA_HOST, insecureBind });
  const remoteListenerPort = remote.enabled ? remote.port : null;

  // --- Dashboard page token (layer 3 of the localhost defense) ---
  // "Any local PROCESS can spawn a permissionless session" is the accepted tradeoff; any local WEB
  // PAGE is not, and the port-exact Origin rule alone leans on one header. This token is minted per
  // process, handed to the page over same-origin GET /control-token, and required to open the control
  // and data sockets from a local client. A page on another origin can issue that fetch but cannot
  // READ the response (no CORS headers on it), so it never learns the token.
  const pageToken = crypto.randomBytes(32).toString('hex');
  const pageTokenBuffer = Buffer.from(pageToken, 'utf8');

  // What the connect snapshot tells the page about which backend it is talking to. A tab left open
  // across a server update reconnects to frames its bundle may predate, so the client reloads when
  // this changes (public/app.js). The boot id is what makes a same-version restart, and a dev rebuild,
  // visible at all.
  const serverBuild = `${require('../package.json').version}+${crypto.randomBytes(4).toString('hex')}`;

  function tokenMatches(presented) {
    if (typeof presented !== 'string' || presented.length !== pageToken.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(presented, 'utf8'), pageTokenBuffer);
    } catch {
      return false;
    }
  }

  // The port a socket landed on IS the listener port: nothing a client sends can change it, and it is
  // the only port the page could have been loaded from, so it is what a loopback Origin must match.
  function listenerPortsFor(socket) {
    const port = socket && typeof socket.localPort === 'number' ? socket.localPort : null;
    return port == null ? [] : [port];
  }

  // Hostnames a Host header may legitimately carry beyond the loopback literals: the remote listener's
  // public name, and whatever the operator allow-listed as an origin (the two are the same names, so
  // deriving them keeps one configured list instead of a second hand-maintained one).
  // Disabled means empty, the same rule normalizeRemoteConfig applies to allowedOrigins: a leftover
  // publicHost in a switched-off remote block must not widen anything.
  const allowedHosts = (remote.enabled
    ? [remote.publicHost, ...remote.allowedOrigins.map(hostOfOrigin)]
    : []
  ).filter((host) => typeof host === 'string' && host !== '');

  const remoteAuth = remote.enabled
    ? createRemoteAuth({
      remote,
      pairingsStore: createPairingsStore({ filePath: defaultPairingsPath(configStore.configPath) }),
      seenStore: createSeenStore({ filePath: defaultSeenPath(configStore.configPath) }),
    })
    : null;

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
  let warnedMissingRtk = false;

  function rtkPathForConfig(cfg) {
    if (!cfg.rtk) return null;
    const rtkPath = getRtkPath();
    if (rtkPath) return rtkPath;
    if (!warnedMissingRtk) {
      warnedMissingRtk = true;
      console.warn('[rtk] config.rtk is true, but no rtk binary was found. Sessions will spawn without rtk hooks.');
    }
    return null;
  }

  // Both switches, in one place: the statusLine relay is part of the usage lane, so usage.enabled false
  // must leave nothing injected even with planLimits left at its default.
  function planLimitsEnabled(cfg) {
    const usageCfg = resolveUsageConfig(cfg.usage);
    return usageCfg.enabled && usageCfg.planLimits;
  }

  function makeSession(project, cfg) {
    const session = new Session({
      id: project.id,
      name: project.name,
      path: project.path,
      dangerouslySkipPermissions: projectSkipPerms(project),
      // Which agent CLI supervises this card. Absent = claude-code; an unknown value warns and
      // falls back to it, so a hand-edited typo costs a card its agent choice, never its boot.
      agent: project.agent,
      // Config-file only, default false, and a spawn-time input like the agent itself: see
      // sessions.js _decideHookTrustBypass for why this is not a dashboard control.
      bypassHookTrust: project.codexBypassHookTrust === true,
      replayBufferKB: cfg.replayBufferKB,
      hookRouter,
      getHookPort,
      // Worktree isolation for real user sessions: each forks off the integration branch and merges
      // back on review. Ephemeral lane sessions are built elsewhere (not makeSession), so they never
      // receive this and run as they did before.
      gitWorkspace,
      integrationBranch: cfg.integrationBranch || 'develop',
      // Eager conflict avoidance (config kill switch). Like every other construction-time option, a
      // settings change reaches a session on its NEXT construction, not the live one.
      autoRebase: cfg.worktreeAutoRebase !== false,
      // Master kill switch for the live cross-session review liveness (the integration-branch reflog
      // watcher each worktree session runs beside its own gitdir watch).
      liveWorktreeReview: cfg.liveWorktreeReview !== false,
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
      rtkPath: rtkPathForConfig(cfg),
      // Resume a prior Claude conversation on spawn (set by the per-card "Resume conversation" picker,
      // persisted on the project record). Null = fresh conversation. See control-handlers resume-conversation.
      resumeSessionId: project.resumeSessionId || null,
      // Context packs delivered as --add-dir at spawn. Hand-edited on the project record in M2 (it is
      // deliberately not a control-WS settable key); the Session validates the shape defensively.
      packs: project.packs,
      // Which per-project variant this project's spawns resolve first (see Session._resolvePacks).
      // The SAME slug the memory projection names its per-project file by.
      packVariantSlug: projectVariantSlug(project.path),
      // Pack read telemetry (config kill switch; undefined -> Session default true).
      packReadTelemetry: cfg.packReadTelemetry,
      // Official plan-limit ingestion via a managed statusLine. Off whenever the usage lane itself is
      // off, so one switch turns the whole lane inert.
      planLimits: planLimitsEnabled(cfg),
    });
    // Signals-only by default (kill switch: config recordSignals); cfg.capture opts into raw PTY
    // bytes on top. See AGENTS.md, "Session Recording".
    const captureConfig = { ...(cfg.capture || {}), baseDir: path.join(path.dirname(configStore.configPath), 'recordings') };
    const recorder = createRecorder(project.name, captureConfig, cfg.recordSignals ?? DEFAULT_CONFIG.recordSignals);
    if (recorder) {
      session.setRecorder(recorder);
    }
    return session;
  }

  // --- Express setup ---

  const app = express();

  // Host allow-list, ahead of even the remote gate. Defense in depth against DNS rebinding: the
  // upgrade path already refuses a rebound page on Origin, so what this covers is the HTTP surface
  // (static assets, /hook, /upload). Loopback literals always pass, so the local dashboard, curl and
  // every hook POST are unaffected.
  app.use((req, res, next) => {
    if (decideHostAllowed(req.headers.host, allowedHosts)) {
      next();
      return;
    }
    res.status(403).type('text/plain').send('Host not allowed');
  });

  // Remote gate FIRST, ahead of every route including /hook: a remote-classified request is refused
  // before any handler sees it. The middleware self-exempts /pair/*, which mountPairRoutes serves.
  if (remoteAuth) {
    app.use(remoteAuth.httpMiddleware);
    remoteAuth.mountPairRoutes(app);
  }

  // The page token, delivered same-origin to the dashboard that just loaded. Mounted AFTER the remote
  // gate, so an unpaired remote device gets a 401 here exactly as it does for the page itself. A
  // cross-origin fetch of this is refused outright rather than relying on the browser to withhold the
  // body: a same-origin GET carries no Origin header at all, so the presence of a disallowed one is
  // itself the tell.
  app.get('/control-token', (req, res) => {
    const origin = req.headers.origin;
    if (origin && !decideOriginAllowed(origin, remote.allowedOrigins, { listenerPorts: listenerPortsFor(req.socket) })) {
      res.status(403).json({ error: 'origin not allowed' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token: pageToken });
  });

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
        req.query?.t ||
        (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
        null;
      const out = hookRouter.handle({
        glissaId: req.params.glissaId,
        event: req.params.event,
        token,
        payload,
      });
      // The managed statusLine relay's POST. Only an ACCEPTED callback is ingested (the token check is
      // HookRouter's, shared with every other event), the payload is normalized and dropped rather than
      // stored or recorded, and the reply below stays the plain ok JSON: the injection shape is
      // UserPromptSubmit-only.
      if (out.status === 200 && isStatuslineEvent(req.params.event)) {
        usage.ingestStatusline(payload);
      }
      // NOT named `body`: this block also reads the accumulated request-body string of that name, and a
      // same-name const here puts it in the temporal dead zone for the whole callback, so JSON.parse
      // threw a ReferenceError that the tolerate-catch above swallowed and EVERY hook payload arrived
      // as {} (dead session_id capture, dead background_tasks gate, dead Notification subtypes).
      const reply = { ok: out.status === 200, reason: out.reason };
      // Live context-pack channel: a UserPromptSubmit reply MAY carry one Glissa-authored notice that
      // a pack this session spawned against has been rebuilt. Only this exact nesting with a matching
      // hookEventName injects anything (verified on Claude Code 2.1.235), only UserPromptSubmit is a
      // reliable per-turn injection point, and only an ACCEPTED callback may consume the notice, so a
      // rejected token can never drain it. With nothing pending the body stays byte-identical to
      // before the channel existed - pinned by tests/backend-pack-notice-hook.test.js.
      const packNotice = out.status === 200 && isUserPromptSubmitEvent(req.params.event)
        ? sessions.get(req.params.glissaId)?.takePackNoticeContext() || null
        : null;
      if (packNotice) {
        reply.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: packNotice };
      }
      res.status(out.status).json(reply);
    });
  });

  // Image ingress: the phone key strip's Image button POSTs the picked file's raw bytes here, and the
  // saved absolute path is bracket-pasted into that session's PTY so the operator can add words and
  // press Enter (Claude Code reads the image off the path). Mounted AFTER the remote gate above, so a
  // paired phone must carry its pairing cookie; on the local listener it sits at the same trust level
  // as the control WS, which can already spawn a session in any directory.
  //
  // Uploads live beside the resolved config file, one directory per session, so a temp GLISSA_CONFIG
  // keeps its uploads in the temp dir too.
  const uploadsRoot = configSiblingPath(configStore.configPath, 'uploads');

  // Keep the newest uploads per session; fire-and-forget after a save, best-effort like the recorder's
  // sweep (all sessions share one event loop, so nothing here blocks or retries).
  async function sweepSessionUploads(dir, justWritten) {
    let entries = null;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of planUploadRetention(entries, { justWritten })) {
      try {
        await fsp.unlink(path.join(dir, name));
      } catch {
        // Locked or already gone; the next upload sweeps again.
      }
    }
  }

  app.post('/upload/:sessionId', (req, res) => {
    const sess = getSessionAny(req.params.sessionId);
    if (!sess) {
      res.status(404).json({ error: 'unknown session' });
      return;
    }
    // A live session id is always a plain uuid; anything that could climb out of uploadsRoot is
    // refused as unknown rather than sanitized into some other session's directory.
    if (!isSafePathSegment(sess.id)) {
      res.status(404).json({ error: 'unknown session' });
      return;
    }
    const typeVerdict = decideUploadType(req.headers['content-type']);
    if (!typeVerdict.ok) {
      res.status(typeVerdict.status).json({ error: typeVerdict.error });
      return;
    }
    // Cheap pre-check so a dead session does not cost a 15MB write; the PTY can still die mid-upload,
    // which the post-save check below catches.
    if (!sess.hasLivePty) {
      res.status(409).json({ error: 'session has no live terminal' });
      return;
    }

    const dir = path.join(uploadsRoot, sess.id);
    const filename = buildUploadFilename({
      now: Date.now(),
      randomSuffix: crypto.randomBytes(4).toString('hex'),
      extension: typeVerdict.extension,
    });
    const savedPath = path.join(dir, filename);

    // The client can reset between its headers and the mkdir below resolving, and this listener has to
    // exist SYNCHRONOUSLY to catch it: an 'error' with no listener is swallowed, and the request would
    // then already be destroyed when the pipeline starts, leaving a write stream nothing ever closes
    // and a partial file nothing ever unlinks (one leaked fd per aborted request).
    let abortedBeforeReceive = false;
    const markAbortedBeforeReceive = () => { abortedBeforeReceive = true; };
    req.on('error', markAbortedBeforeReceive);

    // 0o700 to match the pairing files this sits beside: uploads are the operator's screenshots.
    fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      .then(() => {
        // Nothing has been created yet, so a client that gave up in this window costs nothing.
        if (abortedBeforeReceive || req.destroyed) return;
        req.off('error', markAbortedBeforeReceive);
        receiveUpload({ req, res, sess, dir, filename, savedPath });
      })
      .catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'could not store the upload' });
      });
  });

  function receiveUpload({ req, res, sess, dir, filename, savedPath }) {
    const writeStream = fs.createWriteStream(savedPath);
    let bytesReceived = 0;
    let settled = false;

    const answer = (status, body) => {
      if (settled) return;
      settled = true;
      if (!res.headersSent) res.status(status).json(body);
    };
    // Windows refuses to unlink a file whose handle is still open and destroy() closes the descriptor
    // asynchronously, so a discard waits for the stream's 'close'. Ordering is not assumed in either
    // direction: pipeline's callback can land after 'close' has already fired.
    let discardWanted = false;
    let streamClosed = false;
    const unlinkPartial = () => {
      fsp.unlink(savedPath).catch(() => { /* best effort; the retention sweep catches leftovers */ });
    };
    const discardPartial = () => {
      discardWanted = true;
      if (streamClosed) unlinkPartial();
    };
    writeStream.on('close', () => {
      streamClosed = true;
      if (discardWanted) unlinkPartial();
    });

    // Fires before pipeline's callback, so a disk failure answers 500 rather than the generic 400.
    writeStream.on('error', () => {
      answer(500, { error: 'could not store the upload' });
      discardPartial();
    });
    req.on('data', (chunk) => {
      bytesReceived += chunk.length;
      if (!exceedsUploadCap(bytesReceived)) return;
      answer(413, { error: 'image is too large' });
      req.destroy();
      writeStream.destroy();
      discardPartial();
    });

    // Streamed, never buffered: a 15MB image held in memory would ride the same heap every session's
    // output ring lives on. pipeline, not req.pipe: it owns the error plumbing in both directions, so
    // a client reset destroys the write stream (closing the fd, unlinking the partial) instead of
    // leaving it open forever waiting for an 'end' that a destroyed request never emits.
    pipeline(req, writeStream, (err) => {
      if (err) {
        answer(400, { error: 'upload failed' });
        discardPartial();
        return;
      }
      // A refusal already answered (the size cap, a disk error) must never go on to paste: pipeline
      // reports a destroy after the last chunk as a clean finish.
      if (settled) {
        discardPartial();
        return;
      }
      // The PTY may have exited while the bytes were arriving. An image nobody can paste is a leak.
      if (!sess.hasLivePty) {
        answer(409, { error: 'session has no live terminal' });
        discardPartial();
        return;
      }
      sess.write(framePathPaste(savedPath));
      answer(200, { ok: true, path: savedPath });
      sweepSessionUploads(dir, filename);
    });
  }

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
  // (notify, session-error, post-turn-result) so a reconnecting dashboard can
  // recover exactly what it missed (see control-handlers.js connection handler).
  const controlReplayLog = createReplayLog();

  /*
   * The one place a control frame reaches a socket, so bufferedAmount is checked exactly once rather
   * than at each of the dozen broadcast sites. Policy is pure (core/control-send-core.js): a backed-up
   * socket drops only the periodic pushes whose successor repairs them, and a socket past the hard
   * ceiling is closed so the client reconnects and rebuilds from a snapshot.
   */
  function sendControlFrame(client, payload, type) {
    if (client.readyState !== 1) return;
    const decision = decideControlSend({ bufferedAmount: client.bufferedAmount, type });
    if (decision.action === 'drop') return;
    if (decision.action === 'close') {
      console.warn(`[control-ws] client past the buffer ceiling (${client.bufferedAmount} bytes) - closing so it reconnects`);
      try { client.terminate(); } catch { /* already gone */ }
      return;
    }
    client.send(payload);
  }

  // Stamp a copy: lane runners cache msg for later replay, so stamping in place leaves a stale seq.
  function broadcastControl(msg) {
    const stamped = controlReplayLog.stamp({ ...msg });
    const payload = JSON.stringify(stamped);
    for (const client of controlWss.clients) {
      sendControlFrame(client, payload, stamped.type);
    }
  }

  /*
   * The same broadcast, refused to remote-trust sockets. Ingest frames carry captured terminal output
   * and (later) shell history, which the plan keeps on the machine that produced it exactly as the
   * visions lane keeps live buffers off the remote listener. Trust comes from the listener port
   * stamped on the connection at upgrade, never from anything the client sent; absent trust reads as
   * local, so behavior with remote mode off is unchanged.
   */
  function broadcastLocalControl(msg) {
    const stamped = controlReplayLog.stamp({ ...msg });
    const payload = JSON.stringify(stamped);
    for (const client of controlWss.clients) {
      if (client.glissaTrust === 'remote') continue;
      sendControlFrame(client, payload, stamped.type);
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
    for (const sess of [...sessions.values(), ...reviewSessions.values(), ...investigationSessions.values(), ...distillSessions.values(), ...visionsSessions.values(), ...memoryDistillSessions.values()]) {
      const stats = sess.getHealthStats();
      stats.detection = sess.getDetectionStats();
      stats.ephemeral = !!sess.ephemeral;
      sessionStats.push(stats);
      if (stats.hasPty) alivePtyCount++;
      if (stats.sleeping) sleepingCount++;
      totalDataListeners += stats.dataListenerCount;
      totalOutputBufferBytes += stats.outputBufferBytes;
      // Anomaly checks assume a persisted session with tracked data-WS clients and a stable
      // lifecycle. Ephemeral sessions (PR reviews, PostHog investigations) stream transiently and
      // tear down fast, so they are excluded to avoid false-positive listenerMismatch/orphanPty.
      if (!sess.ephemeral) {
        const clientCount = sessionDataClients.get(stats.id)?.size || 0;
        // The ingest lane's terminal tap is a server-side `data` listener the client map cannot see.
        const ingestTapCount = ingestLane?.hasSessionTap(sess) ? 1 : 0;
        if (stats.dataListenerCount !== clientCount + ingestTapCount) listenerMismatch = true;
        if (stats.hasPty && (stats.state === STATES.DONE || stats.state === STATES.FAILED || stats.state === STATES.DORMANT)) {
          orphanPty = true;
        }
      }
      if (stats.destroyed) destroyedReachable = true;
    }
    let dataClientTotal = 0;
    for (const clients of sessionDataClients.values()) {
      dataClientTotal += clients.size;
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

  const clientPresence = createClientPresence();

  // The ladder's last rung reads its delay from config like every other timeout (0 switches it off).
  const phoneEscalationMs = () => (
    config.phoneEscalationMs == null ? DEFAULT_PHONE_ESCALATION_MS : config.phoneEscalationMs
  );
  const notificationManager = new NotificationManager({
    escalationIntervalMs: ESCALATION_INTERVAL_MS,
    debounceMs: config.notifyDebounceMs || 3000,
    phoneEscalationMs: phoneEscalationMs(),
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
  // Off-dashboard channel: reaches the operator's phone when NO dashboard tab is open anywhere, so
  // the web channel's broadcast would land on nobody. Registered unconditionally and gated per
  // delivery off live config (telegramNotifications + the telegram credentials the PR lane already
  // defines), so the toggle needs no restart and no re-registration. Absent key = never sends.
  //
  // Durable by the operator's 2026-08 ruling: a lost browser notification on restart is acceptable,
  // a lost phone ping is not, because Telegram is the channel of last resort. Every ping it sends is
  // recorded in the outbox BEFORE it is attempted and removed only on a confirmed send, so a crash
  // mid-delivery replays it at the next boot rather than losing it. The credentials are read at send
  // time, so a replayed entry uses whatever config the new process holds.
  const telegramOutbox = createTelegramOutbox({
    filePath: configSiblingPath(configStore.configPath, 'telegram-outbox.json'),
    send: (entry) => {
      const telegram = config.telegram || {};
      if (!telegram.botToken || !telegram.chatId) return Promise.resolve({ ok: false });
      return sendTelegramMessage({
        botToken: telegram.botToken, chatId: telegram.chatId, text: entry.text, tag: 'channel:telegram',
      });
    },
  });
  notificationManager.registerChannel('telegram', createTelegramChannel({
    getConfig: () => config,
    getConnectionCount: () => clientPresence.connectionCount(),
    outbox: telegramOutbox,
  }), {
    offDashboard: true,
    // Read live, and through the SAME gate the delivery itself uses, so the ladder cannot arm a timer
    // for a channel that would drop what it fires. A zero connection count is passed because that
    // clause is not what an escalation turns on: only the opt-in and the credentials decide here.
    canEscalate: () => decideTelegramNotification({
      enabled: config.telegramNotifications === true,
      botToken: config.telegram?.botToken,
      chatId: config.telegram?.chatId,
      connectionCount: 0,
      phoneEscalation: true,
    }).send,
  });
  // Replay whatever a previous process queued but never confirmed. Fire-and-forget: it never rejects,
  // and a boot must not wait on the network.
  void telegramOutbox.replay();

  // --- Client presence (per-connection focus; drives suppression and the off-dashboard channel) ---
  // Bookkeeping and both decisions are pure (server/core/client-presence.js); this is the IO shell
  // that registers a key per control connection and pushes the resulting boolean into the manager.
  // Per-connection, not global: with a phone paired through the remote listener, a dashboard left
  // focused at the desk used to suppress the phone's notification forever.

  function updateNotifySuppression() {
    notificationManager.setFocusSuppressed(clientPresence.shouldSuppress());
  }

  function handleClientFocus(ws, focused) {
    clientPresence.setFocus(ws, focused);
    updateNotifySuppression();
  }

  controlWss.on('connection', (ws) => {
    clientPresence.connect(ws);
    updateNotifySuppression();
    ws.on('error', (err) => {
      console.warn(`[control-ws] Error: ${err.message}`);
    });
    // Recount on disconnect: a dashboard that crashes while focused must not suppress forever.
    ws.on('close', () => {
      clientPresence.disconnect(ws);
      updateNotifySuppression();
    });
  });

  /*
   * Protocol ping/pong on both channels. Presence LIES without it: a half-open socket TCP has not
   * noticed stays in the client set until the OS timeout, and while it does, the Telegram
   * zero-connections gate is silently blocked - the channel of last resort, defeated by a connection
   * nobody is on. Terminating a silent socket is what drops it out of clientPresence (via its 'close'
   * event) and lets that gate open.
   */
  const heartbeat = createHeartbeat({ servers: [controlWss, dataWss] });
  controlWss.on('connection', (ws) => heartbeat.track(ws));
  dataWss.on('connection', (ws) => heartbeat.track(ws));
  heartbeat.start();

  // --- Session management ---
  // Sessions are keyed by stable `id` (UUID), not mutable `name`.

  const sessions = new Map();
  // sessionId -> Map<ws, { cols, rows, resizeSeq } | null>. The keys are the health telemetry's
  // data-client count; the values carry each connection's last declared viewer size so a viewer that
  // stops looking can hand the PTY back to whoever is still watching (server/core/viewer-size-core.js).
  const sessionDataClients = new Map();
  let nextViewerResizeSeq = 0;
  // Headless PR-review sessions (opt-in poller). Their own map so config hot-reload diffing
  // (diffProjects) never destroys a live review, they are never persisted to config.json, and
  // shutdown() can reap in-flight review PTYs without touching persisted sessions.
  const reviewSessions = new Map();
  // Headless PostHog investigation sessions (opt-in poller). Own map for the same reasons as
  // reviewSessions: never persisted, never surfaced as a card, reaped independently on shutdown.
  const investigationSessions = new Map();

  // The manager keys its entries by the session id passed to trigger(), so a lifecycle hop can be
  // routed straight back into that session's decision trace: focus suppression, the debounce and
  // escalation otherwise produce no evidence anywhere. An entry with no session is skipped.
  notificationManager.on('notification-state-change', ({ session, from, to, event, category }) => {
    const sess = sessions.get(session);
    if (!sess) return;
    sess.recordNotifyDecision({ ts: Date.now(), kind: 'notify-state', from, to, event, category });
  });

  function closeSessionDataClients(sessionId) {
    const clients = sessionDataClients.get(sessionId);
    if (clients) {
      for (const ws of clients.keys()) {
        ws.close(1001, 'Session removed');
      }
      sessionDataClients.delete(sessionId);
    }
  }

  // --- Shared spawn + worktree engines ---

  const spawnGate = createSpawnGate();
  // Every isolated lane (a session, a PR review) executes in a git worktree on a dedicated branch,
  // fast-forwarded back on success (see git-workspace.js), so it never dirties the user's working tree.
  // rerere is enabled per repo the first time a worktree is created there, so a conflict resolved once
  // is replayed on every later rebase of every linked worktree (config kill switch, read once at boot).
  const gitWorkspace = createGitWorkspace({ rerere: config.worktreeRerere !== false });

  // On-disk session worktrees from a prior run are reconciled AFTER the boot session loop below, so a
  // worktree holding unmerged work can be re-adopted onto its session instead of swept (see the
  // reconcile after `for (const project of config.projects)`).

  /** Look up a session by id. */
  function getSessionAny(id) {
    return sessions.get(id) || null;
  }
  function getProjectPathById(projectId) {
    const p = config.projects.find((x) => x.id === projectId);
    return p ? p.path : null;
  }
  function getProjectNameById(projectId) {
    const p = config.projects.find((x) => x.id === projectId);
    return p ? p.name : null;
  }
  // GitHub PR auto-review lane (server/pr-review-wiring.js): inert unless config.prReview.enabled and
  // config.telegram are both set. Started at boot below, restarted on a prReview/telegram settings
  // change, stopped in shutdown().
  /*
   * Lane attribution ledger. Glissa spawns its own sessions, so it can say that a Claude session id WAS the
   * PR-review lane rather than someone typing; that is the one usage question a transcript reader cannot
   * answer. Beside the config file like the warehouse and the budget state, so a temp GLISSA_CONFIG stays
   * out of the operator's real ~/.glissa. Loaded eagerly: a report built before the first read would
   * attribute everything to `other`.
   */
  const laneLedger = createLaneLedger({
    ledgerPath: configSiblingPath(configStore.configPath, 'usage-lanes.json'),
    retainDays: resolveUsageConfig(config.usage).warehouseRetainDays,
    logger: console,
  });
  void laneLedger.load();
  const recordLane = laneLedger.record;

  const prReview = createPrReviewWiring({
    config, reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, gitWorkspace, recordLane,
    getProjectPathById, getProjectNameById,
    broadcast: (msg) => broadcastControl(msg),
  });

  // PostHog monitoring lane (server/posthog-wiring.js): inert unless config.posthog.enabled and
  // config.telegram are both set. Same lifecycle as the PR lane - started at boot below, restarted on
  // a posthog/telegram settings change, stopped in shutdown().
  const posthog = createPosthogWiring({
    config, investigationSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
    // Only the opt-in auto-fix job uses it, and only to isolate its throwaway worktree.
    gitWorkspace,
    broadcast: (msg) => broadcastControl(msg),
  });

  /*
   * Ingest lane: config-file only, absent config constructs nothing (docs/plan-ingestion.md, M6), the
   * same shape as the Visions lane below it. Every source is individually opt-in ON TOP of the lane
   * flag, so a lane whose sources are all off builds no adapter, holds no ring and taps nothing.
   * Constructed BEFORE the Visions lane because that lane takes this one's digest as a dependency.
   */
  const ingestConfig = resolveIngestConfig(config.ingest);
  const visionsConfig = resolveVisionsConfig(config.visions);
  const visionsEnabled = visionsConfig.enabled;
  /*
   * The git source's watch set (docs/plan-ingestion.md, M8): the checkouts glissa's OWN project sessions
   * are working in, which is the same session-following rule the plan gives the fs source. Both halves of
   * a worktree session count, because a session commits in its worktree while merges land in the project
   * checkout, and neither is visible from the other's HEAD.
   *
   * The exclusion rides the map, not a filter: ephemeral lane sessions (pr-review, visions dispatch,
   * posthog, pack-distill) are registered in their own maps and never enter `sessions`, so a pr-review
   * worktree and a visions dispatch's throwaway workdir are outside the watch set BY CONSTRUCTION,
   * exactly as the terminal tap's placement in wireSessionEvents excludes them there.
   */
  const gitRepoRoots = () => {
    const dirs = [];
    for (const sess of sessions.values()) {
      for (const dir of [sess.path, sess.worktreeDir]) {
        if (typeof dir !== 'string' || !dir || dirs.includes(dir)) continue;
        dirs.push(dir);
      }
    }
    return dirs;
  };
  /*
   * Long-term memory store (docs/plan-visions-3.md, M12): config-file only and DEFAULT OFF, because the
   * lane durably persists distilled transcript content. Off constructs nothing: no object, no timer, no
   * fs touch. It is constructed BEFORE the Visions lane because that lane's M13 writers take it as a
   * dep; the M16 delivery hangs off the same handle. It is constructed ABOVE the ingest lane because
   * that lane's agent-log source fans out to this store's ingest consumer (M14).
   */
  const memoryConfig = resolveMemoryConfig(config.memory);
  const memoryStore = memoryConfig.enabled
    ? createMemoryStore({
      dir: configSiblingPath(configStore.configPath, 'memory'),
      // The machine-wide database, memory's first tenant. Null store = no node:sqlite = lane off (M12b).
      dbPath: path.join(path.dirname(configStore.configPath), DB_FILE_NAME),
      config: memoryConfig,
      logger: console,
      // Same reason as the ingest and visions lanes: the setting moves, the store is built once.
      debug: () => configStore.getSettings().debugMode === true,
    })
    : null;

  // The M14 ingest consumer: it taps the source's MAPPED events and stamps them `reported`. Null with memory off.
  const memoryIngest = memoryStore
    ? createMemoryIngest({
      store: memoryStore,
      logger: console,
      // The same ledger the ring consumer reads: an ephemeral lane's own transcript is never remembered.
      laneMap: () => laneLedger.laneMap(),
      // How far back that exclusion can actually speak, so the backfill skips transcripts predating it.
      laneFloorMs: () => earliestLaneEntryMs(laneLedger),
      debug: () => configStore.getSettings().debugMode === true,
    })
    : null;

  /*
   * The memory-distill lane (M15): automatic once memory is on, since a projection nobody distills is a
   * dump of raw records. `config.memory.distill.enabled: false` is the kill switch, and memory off
   * constructs nothing at all.
   */
  const memoryDistillSessions = new Map();
  const memoryDistiller = memoryStore
    ? createMemoryDistiller({
      store: memoryStore,
      config: resolveMemoryDistillConfig(config.memory ? config.memory.distill : null, { memoryEnabled: true }),
      logger: console,
      debug: () => configStore.getSettings().debugMode === true,
      spawnDistill: createMemoryDistillSpawn({
        sessions: memoryDistillSessions,
        closeSessionDataClients,
        hookRouter,
        getHookPort,
        spawnGate,
        recordLane,
        replayBufferKB: config.replayBufferKB,
      }),
    })
    : null;

  const ingestLane = ingestConfig.enabled
    ? createIngestLane({
      ...(options.ingestLaneOptions || {}),
      config: ingestConfig,
      logger: console,
      broadcast: (msg) => broadcastLocalControl(msg),
      // Feeds the M7 feedback-loop exclusion; rationale at the consuming site in ingest-wiring.js.
      laneMap: () => laneLedger.laneMap(),
      // The M14 fan-out. Empty with memory off, and the lane is then byte-identical to the pre-M14 one.
      agentLogConsumers: memoryIngest ? [memoryIngest.consumer] : [],
      repoRoots: gitRepoRoots,
      // The fs source ignores the state files the daemon writes beside this path. It matters most in a
      // dev checkout, where the resolved config file is the repo's own config.json and every
      // resumeSessionId save would otherwise look like project activity.
      configPath: configStore.configPath,
      // Read per line rather than captured, because debugMode is settable from the dashboard while this
      // lane is constructed once at boot.
      debug: () => configStore.getSettings().debugMode === true,
      /*
       * The other half of activity-driven dispatch (docs/plan-ingestion.md, M7.5), wired only when BOTH
       * lanes exist. Late-binding on purpose: the Visions lane is constructed below, and the first
       * poke can only arrive a batch interval after both are up.
       */
      onActivity: visionsEnabled ? () => visionsLane.noteActivity() : null,
    })
    : null;

  /*
   * Visions lane: absent config constructs nothing (docs/archive/plan-navigator.md, "Wire and
   * trust"). The Settings dialog can persist config.visions, but this lane is constructed only at
   * boot, so changes take effect after server restart. Its tier 3 model dispatch is a second opt-in
   * inside that one: without config.visions.dispatch.enabled the dispatcher is never constructed, so
   * the lane arms no dispatch timer and can spawn nothing. Its sessions get their own ephemeral map for
   * the same reasons as the PR and distill lanes, and it is that registration (logPrefix 'visions')
   * that puts the lane on the usage ledger.
   */
  // `memory.enabled` implies the SOURCE only, so with the ingest lane off the consumer builds its own.
  if (memoryIngest && !ingestLane?.agentLogsEnabled) memoryIngest.startOwnSource();

  const visionsDispatchConfig = visionsConfig.dispatch;
  const visionsScopeProjects = visionsEnabled
    ? resolveVisionsScopeProjects(visionsConfig.projects, config.projects)
    : null;
  const visionsSessions = new Map();
  const visionsLane = visionsEnabled
    ? createVisionsWiring({
      logger: console,
      broadcast: (msg) => broadcastControl(msg),
      // Same reason as the ingest lane above: the setting moves, the lane is built once.
      debug: () => configStore.getSettings().debugMode === true,
      dispatchConfig: visionsDispatchConfig,
      // Tier 1's push half only; the codeAction pull half is always on with the lane.
      autoFix: visionsConfig.autoFix,
      intentStatePath: configSiblingPath(configStore.configPath, 'visions-intent.json'),
      dispatch: visionsDispatchConfig.enabled
        ? createVisionsDispatcher({
          spawnSession: createVisionsSpawn({
            sessions: visionsSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
            replayBufferKB: config.replayBufferKB,
          }),
          timeoutSeconds: visionsDispatchConfig.dispatchTimeoutSeconds,
          model: visionsDispatchConfig.model,
        })
        : null,
      // One cross-source context section in the dispatch prompt. Null with no ingest lane, and the
      // prompt is then byte-identical to the pre-M6 one.
      contextDigest: ingestLane ? ingestLane.buildDigest : null,
      // The movement signal beside it: new events, never aging timestamps. Null with no ingest lane, and
      // the gate then decides exactly what it decided before M7.5.
      contextSeq: ingestLane ? ingestLane.latestSeq : null,
      scopeProjects: visionsScopeProjects,
      // The M13 memory writers, inert on a default config because the store is then null.
      getMemoryStore: () => memoryStore,
      // Every project the machine knows, so an intent slot for a DELETED project is dropped on load.
      knownProjectIds: (Array.isArray(config.projects) ? config.projects : [])
        .map((project) => project?.id)
        .filter((id) => typeof id === 'string' && id),
    })
    : null;

  // Context-pack auto-rebuild (server/pack-service.js): watchers on each spec's source roots plus a
  // fallback sweep. Started at boot below unless config.packsAutoRebuild is false, stopped in
  // shutdown(). A published rebuild tells every dashboard the new version so a card whose session was
  // spawned against an older one can say so, and arms a next-turn notice on the live sessions running
  // on the old build (its skills hot-reload from the pack dir, its CLAUDE.md and rules do not).
  // A spec nothing delivers is neither watched nor swept, and the projects' own lists are read live so
  // assigning a pack from the Mill tab (or by hand) starts that work without a restart.
  const packService = createPackService({
    consumedPackNames: () => consumedPackNames(config),
    // Read live like the consumer set: a project's path or pack list is what derives its pack variants.
    variantProjects: () => packVariantProjects(config),
    ...(options.packServiceOptions || {}),
  });
  packService.on('pack-updated', ({ name, version }) => {
    broadcastControl({ type: 'pack-updated', name, version });
    // Live channel: arm a next-turn notice on every session that SPAWNED against an older version of
    // this pack (notePackUpdate ignores the rest). Nothing needs seeding at boot - a spawn resolves
    // the built version it delivers, so delivered equals latest until a rebuild publishes.
    for (const sess of sessions.values()) sess.notePackUpdate(name, version);
  });

  // Mill tab (server/mill-wiring.js): a pull surface over the same specs and built packs the service
  // above maintains. No timer, no durable state and nothing constructed per session, so it is always
  // wired: the cost is one spec walk per request, and only when a dashboard asks.
  const mill = createMillWiring({
    config,
    listSessions: () => [...sessions.values()].map((sess) => sess.toSnapshot()),
    getWatcherCount: () => packService._watcherCount(),
    ...(options.millWiringOptions || {}),
  });

  // Usage tracking lane (server/usage-wiring.js): on by default, but started LAZILY on the first
  // control connection (the initial transcript scan is the expensive pass and nobody is watching at
  // cold boot). Spawns nothing: it reads the Claude Code JSONL transcripts and nothing else.
  const usage = createUsageWiring({
    config, sessions,
    broadcast: (msg) => broadcastControl(msg),
    controlClientCount: () => controlWss.clients.size,
    // Durable per-day history, beside the resolved config file like uploads and recordings, so a temp
    // GLISSA_CONFIG never writes into the operator's real ~/.glissa.
    warehousePath: configSiblingPath(configStore.configPath, 'usage-warehouse.json'),
    laneMap: () => laneLedger.laneMap(),
    budgetStatePath: configSiblingPath(configStore.configPath, 'usage-budget-state.json'),
    ...(options.usageWiringOptions || {}),
  });
  // Deferred boot pass: idempotent, so only the first connection pays for it. Registered here, not in
  // the presence listener above, which is declared before `usage` exists (temporal dead zone).
  controlWss.on('connection', () => {
    void usage.start();
  });

  // Context-pack distiller (server/pack-distiller.js): opt-in, off by default, regenerates a pack's
  // DERIVED source files when what they distill has drifted. It writes only under packs/, so the pack
  // service's own watcher sees the written file and rebuilds that pack: the two loops compose without
  // either knowing about the other. Its sessions live in their own ephemeral map, reaped in shutdown().
  const distillSessions = new Map();
  const packDistiller = createPackDistiller({
    enabled: config.packDistiller ? config.packDistiller.enabled === true : false,
    intervalHours: config.packDistiller?.intervalHours || DEFAULT_INTERVAL_HOURS,
    timeoutSeconds: config.packDistiller?.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS,
    spawnDistill: createDistillSpawn({
      sessions: distillSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
      replayBufferKB: config.replayBufferKB,
    }),
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
    sess.on('claude-session-id', ({ id, vendor }) => {
      persistProjectField('resumeSessionId', id);
      // A managed card is the operator working: the lane every other lane is measured against. The vendor
      // namespaces the ledger key so a codex card's id cannot collide with a claude card's.
      recordLane(id, INTERACTIVE_LANE, vendor);
      // The card's usage totals are attributed through this id, so the mapping it just changed makes
      // the last usage-sessions payload wrong for this card.
      usage.refreshSessions();
    });

    sess.on('resume-cleared', () => {
      persistProjectField('resumeSessionId', null);
      broadcastControl({ type: 'session-resume', id: sess.id, resumeSessionId: null });
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
    // Gated to real project sessions (not the ephemeral lane sessions, which run in
    // throwaway worktrees their lane manages). Config resolved at run time
    // because config.projects is refreshed on reload; debounced so a burst of
    // turn-ends collapses to one run after the agent settles.
    // Resolve config fresh each call: config.projects is refreshed on reload, and
    // returns null for an ephemeral session (not a user project) so it is skipped.
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

    // Second, independent listener on the same signal: a finished turn is when this session's
    // transcript grew, so the usage lane rescans (its own 2s debounce, shared across sessions). Kept
    // apart from the hygiene checker above so neither one's debounce or config gate touches the other.
    sess.on('post-turn-check', () => usage.nudgeSession());

    sess.on('state-change', ({ from, to, event, detail }) => {
      broadcastControl({
        type: 'state-change',
        id: sess.id,
        session: sess.name,
        from, to, event,
        timestamp: Date.now()
      });

      // A spawn resolves its context packs immediately before this event, so this is where a live
      // dashboard learns which versions the session actually got. Without it the delivered versions
      // would only ever arrive with a snapshot, and a session restarted under an open dashboard
      // would keep showing the pre-restart (now wrong) staleness verdict.
      if (event === 'spawn_success' || event === 'spawn_fail') {
        broadcastControl({ type: 'session-packs', id: sess.id, packs: sess.toSnapshot().packs });
      }

      // wasActive: the boot-time auto-resume signal (design B; decision logic in
      // decideWasActiveFlip). Flips only, so this writes config.json a handful of times per
      // session lifetime, not on every transition.
      const nextWasActive = decideWasActiveFlip(to, event, sess.pendingRestart);
      if (nextWasActive !== null && nextWasActive !== lastPersistedWasActive) {
        lastPersistedWasActive = nextWasActive;
        persistProjectField('wasActive', nextWasActive);
      }

      // Notification triggers: session state -> notification lifecycle. The decision (which
      // category fires for this state entry, if any, and why) lives in session/core/notify-gate.js
      // explainNotification, shared with its tests. Both turn-complete (COMPLETE) and process
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

      const { category: notifyCategory, reason: notifyReason } = explainNotification(
        to, notifyGate, event, { signal: detail?.signal, hookSeen: sess.hookSeen },
      );
      // The decision and its evidence go into the session's decision trace (debug overlay +
      // recorder). Without this a silent state entry leaves no trace of having been considered.
      sess.recordNotifyDecision({
        ts: Date.now(),
        kind: 'notify',
        to,
        event: event || null,
        signal: detail?.signal || null,
        hookSeen: sess.hookSeen,
        category: notifyCategory,
        reason: notifyReason,
      });
      if (notifyCategory) {
        const messages = {
          waiting: `${sess.name} needs your input`,
          complete: `${sess.name} finished working`,
          failed: `${sess.name} failed`,
        };
        notificationManager.trigger(sess.id, notifyCategory, messages[notifyCategory]);
      }
    });

    /*
     * The fs ingest source's ref-counted roots (docs/plan-ingestion.md, M9). Its own listener rather than
     * a branch inside the big state-change handler above, because it shares nothing with the notification
     * and persistence decisions there: the source watches a root while a session in it is alive, and the
     * state machine is the authority on which sessions those are. Idempotent by contract, so firing on
     * every transition costs a compare rather than a resubscribe. Registered only when the source is on,
     * because a lane that is off owes this session zero listeners.
     */
    if (ingestLane?.fsEnabled) sess.on('state-change', () => ingestLane.noteSessionRoots(sess));

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
      // The worktree that will take this session's commits exists only as of now, so the git ingest
      // source is told to re-derive its watch set rather than finding it up to a poll interval later.
      if (ingestLane) void ingestLane.noteRepos();
      // Same reason for the fs source, which has no poll at all: the directory this session will do its
      // editing in did not exist when its first state-change fired.
      if (ingestLane?.fsEnabled) ingestLane.noteSessionRoots(sess);
    });

    // On an in-place restart (restart()/forceRestart()/sleep-kill auto-restart) the
    // session's monotonic output offset resets to 0 (sessions.js start()). Any LIVE
    // data-WS client's ws-sender.sentOffset is now stale-high, which would silently
    // disable its in-place backfill until the client happens to reconnect. Force-close
    // those clients so they auto-reconnect (terminal.js) and re-baseline startOffset
    // through the connect path above. Server-only; the client is unchanged. Harmless
    // no-op when no data clients are attached (e.g. the first start()).
    sess.on('rebaseline', () => closeSessionDataClients(sess.id));

    /*
     * Terminal ingest tap (docs/plan-ingestion.md, M6). Its PLACEMENT is the load-bearing part: only
     * project sessions pass through wireSessionEvents, so an ephemeral lane session (visions,
     * pr-review, posthog, pack-distill) registered through registerEphemeralSession is excluded BY
     * CONSTRUCTION. Without that, the Visions lane's own dispatch output would feed straight back into its
     * next prompt. Pinned by tests/ingest-backend.test.js.
     */
    if (ingestLane?.terminalEnabled) ingestLane.attachSessionTap(sess);
  }

  // Sessions are constructed dormant - no PTY spawns on boot. The user starts
  // a session on demand by expanding its chip from the minimized bar, which
  // sends a `start-session` control message.
  for (const project of config.projects) {
    const sess = makeSession(project, config);
    sessions.set(project.id, sess);
    wireSessionEvents(sess);
  }

  /*
   * The git watch set is derived from the map the loop above just filled, and the ingest lane is
   * constructed well before that loop (the Visions lane below it takes this one's digest as a
   * dependency). Without this poke the source starts with an empty set and stays inert until its first
   * 60s poll, whose first read of each repo is a BASELINE, so a commit or branch switch made in that
   * window is absorbed and never reported. Pinned by tests/ingest-backend.test.js.
   */
  if (ingestLane) void ingestLane.noteRepos();

  // Reconcile the on-disk session worktrees a prior run/crash/shutdown left behind (decision table and
  // rationale on reconcileSessionWorktrees). Once per distinct repo root, best-effort.
  try {
    // One-shot cold reconcile at boot (before any live session streams): use the SYNCHRONOUS engine
    // sibling so this blocking pass steals no PTY time from running sessions and never awaits. The live
    // async `gitWorkspace` is reserved for the recurring session and PR-review paths.
    reconcileSessionWorktrees({
      projects: config.projects,
      sessions,
      gitWorkspaceSync: createGitWorkspaceSync(),
      integrationBranch: config.integrationBranch || 'develop',
    });
  } catch (err) {
    console.warn(`[worktree] worktree reconcile failed: ${err.message}`);
  }
  // Explicit, not emergent: adoption above sets worktreeDir on sessions the poke before it already read,
  // and it only reaches the watch set today because that poke is still in flight when it does.
  if (ingestLane) void ingestLane.noteRepos();

  let pendingAutoResumeOnListening = null;
  const startAutoResume = () => {
    pendingAutoResumeOnListening = null;
    runAutoResume(sessions, config, spawnGate);
  };
  // Smart auto-resume (design C): sessions active when Glissa last shut down come back with
  // their live Claude conversation resumed. Runs after worktree reconciliation, so a re-adopted
  // pending-review worktree is already in place before the session spawns into it. Fire-and-
  // forget: boot does not block on PTY spawns finishing (matches _addNewSessions' sess.start()).
  // Hooks need the bound port (getHookPort), so a pre-listen boot waits for 'listening'.
  const scheduleAutoResume = () => {
    if (httpServer.listening) {
      startAutoResume();
      return;
    }
    pendingAutoResumeOnListening = startAutoResume;
    httpServer.once('listening', pendingAutoResumeOnListening);
  };
  scheduleAutoResume();

  // Budgeted and resumable, so a year of transcripts costs one bounded pass per boot rather than a stall.
  if (memoryIngest) {
    memoryIngest.backfill().catch((err) => console.warn(`[memory-ingest] backfill failed: ${err.message}`));
  }

  // Its first tick lands during the backfill above, where the quiet window defers it; the loop retries.
  if (memoryDistiller) {
    memoryDistiller.start().catch((err) => console.warn(`[memory-distill] start failed: ${err.message}`));
  }

  // --- GitHub PR auto-review poller (opt-in; inert unless config.prReview.enabled) ---
  prReview.startPoller();

  // --- PostHog monitoring poller (opt-in; inert unless config.posthog.enabled) ---
  posthog.startPoller();

  // --- Context-pack auto-rebuild (on by default; config.packsAutoRebuild is the kill switch) ---
  // Fire-and-forget like the other boot lanes: the first sweep walks every spec's sources and boot
  // must not wait on it. Inert with no specs (start() installs nothing and returns).
  // Snapshotted at boot because that is when this switch is documented to be read: a later reload
  // moving it must not quietly install the watchers a boot-time false decided against.
  const packsAutoRebuildEnabled = config.packsAutoRebuild !== false;
  if (packsAutoRebuildEnabled) {
    packService.start().catch((err) => console.warn(`[packs] auto-rebuild failed to start: ${err.message}`));
  }

  // --- Context-pack distiller (opt-in; inert unless config.packDistiller.enabled) ---
  // Fire-and-forget: start() runs one drift pass immediately (a source edited while Glissa was down is
  // the case worth catching) and then every intervalHours. Disabled is a no-op returning at once.
  packDistiller.start().catch((err) => console.warn(`[distill] failed to start: ${err.message}`));

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
      // Packs are read at spawn, so an edited list only reaches the session through a recreate - the
      // same treatment permsChanged already gets for the same reason.
      const packsChanged = JSON.stringify(normalizePackNames(newP.packs).names) !== JSON.stringify(sess.packNames);
      // The agent is a spawn-time input like packs: an edited value reaches the session only by recreate.
      const agentChanged = resolveAdapter(newP.agent).id !== sess.agentId;
      const hookTrustChanged = (newP.codexBypassHookTrust === true) !== sess.bypassHookTrust;
      if (pathChanged || permsChanged || packsChanged || agentChanged || hookTrustChanged) {
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
    // Before destroy(): this session is leaving for good, and destroy() emits no 'exit' and no final
    // state-change, so nothing else would ever take its ingest tap or its fs root off the lane's roster.
    if (ingestLane) ingestLane.detachSessionTap(sess);
    if (ingestLane) ingestLane.releaseSessionRoots(sess);
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
      broadcastControl({ type: 'session-added', id: project.id, session: project.name, path: project.path, state: sess.state, stateSince: sess.stateSince, skipPerms: !!sess.dangerouslySkipPermissions, worktree: !!sess.isWorktree, resumeSessionId: sess.resumeSessionId || null });
      sess.start();
      console.log(`[config] Added session: ${project.name}`);
    }
    // A project added by a config reload is a new checkout to watch, and waiting for the 60s poll would
    // baseline whatever was done in it meanwhile.
    if (ingestLane) void ingestLane.noteRepos();
  }

  function _modifyChangedSessions(modified, newConfig) {
    for (const project of modified) {
      const oldSess = sessions.get(project.id);
      const wasDormant = !shouldStartAfterModify(oldSess.state);
      closeSessionDataClients(project.id);
      // INVARIANT: acknowledge BEFORE destroy - destroy() calls removeAllListeners()
      notificationManager.acknowledge(project.id);
      oldSess.destroy();
      const newSess = makeSession(project, { ...config, ...newConfig });
      sessions.set(project.id, newSess);
      // Wire listeners BEFORE the carry-over: adoptWorktree emits merge-status synchronously, and an
      // unwired emit is dropped, leaving open dashboards merge-clean while the server holds
      // pending-review (the boot reconcile wires-then-adopts in this same order).
      wireSessionEvents(newSess);
      carryWorktreeAcrossRecreate(oldSess, newSess);
      // Broadcast BEFORE start() - see _addNewSessions for rationale.
      broadcastControl({ type: 'session-modified', id: project.id, session: project.name, path: project.path, state: newSess.state, stateSince: newSess.stateSince, skipPerms: !!newSess.dangerouslySkipPermissions, worktree: !!newSess.isWorktree, resumeSessionId: newSess.resumeSessionId || null });
      if (!wasDormant) newSess.start();
      console.log(`[config] Modified session: ${project.name}${wasDormant ? ' (left dormant)' : ''}`);
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
      phoneEscalationMs: phoneEscalationMs(),
    });
    // No-op unless this save actually changed config.prReview/telegram; the restart itself is
    // serialized and drains in-flight reviews (see pr-review-wiring.js).
    prReview.restartIfConfigChanged();
    // Same gating for the PostHog lane: no-op unless this save changed config.posthog/telegram.
    posthog.restartIfConfigChanged();
    // And for the usage lane: no-op unless this save changed config.usage.
    usage.restartIfConfigChanged();
    // The mill watches and sweeps only what something delivers, so a project's pack list gaining its
    // first consumer for a spec (or losing its last) is what starts and stops that work. applyConfigReload
    // sets config.projects before delegating here, so both halves of the consumer set are already live.
    if (packsAutoRebuildEnabled) packService.restartIfConsumersChanged();
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
  // Abort handle for the in-flight update check, so shutdown can cancel it instead of waiting out its
  // timeout. Per RUN, not shared: a timed-out boot check aborts its controller, and reusing that one
  // would leave every daily recheck born aborted.
  let updateAbort = null;
  // Declared here so shutdown() (defined below the kickoff) can clear the periodic recheck.
  let updateRecheckInterval = null;

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
    // Cached last PostHog tick summary, replayed to a client that connects between ticks.
    getPosthogStatus: () => posthog.getStatus(),
    // Per-issue Radar action: the one PostHog write (resolve/suppress).
    posthogSetIssueStatus: (args) => posthog.setIssueStatus(args),
    // Investigations inbox: archive one completed record (cached-status patch + rebroadcast).
    posthogArchiveInvestigation: (args) => posthog.archiveInvestigation(args),
    // Same for the PR auto-review lane.
    getPrStatus: () => prReview.getStatus(),
    // Latest built version per pack, so a connecting client can tell which sessions were spawned
    // against an older one. Empty while auto-rebuild is off: nothing then knows a pack moved.
    getPackVersions: () => packService.getVersions(),
    // Version plus a per-process boot id: a restart onto the SAME version still means new frames from
    // a new process, and a dev rebuild does not bump the version at all.
    serverBuild: () => serverBuild,
    // Usage lane: the small per-card payload is rebuilt live on connect, the large report is replayed
    // from its cache, and a report request is served on demand.
    getUsageSessions: () => usage.getSessionsMessage(),
    getUsageReport: () => usage.getCachedReport(),
    requestUsageReport: (args) => usage.requestReport(args),
    // Official plan limits are machine-wide, so the freshest snapshot is replayed to every client that
    // connects rather than being rebuilt per session.
    getPlanLimits: () => usage.getPlanLimitsMessage(),
    // Context mill: assembled on demand, and the last one replayed to a connecting client.
    millReport: mill,
    // Which pack names exist, so a Mill tab assignment is validated against the specs on disk.
    listPackNames: () => mill.listPackNames(),
    // Build a newly delivered pack before the assignment's reload recreates the session. Gated on the
    // same switch as the loops: with auto-rebuild off, a pack is whatever `glissa pack build` last wrote.
    ensurePacksBuilt: (names, savedConfig) => (packsAutoRebuildEnabled
      ? packService.ensureBuilt(names, { projects: packVariantProjects(savedConfig || config) })
      : Promise.resolve()),
  });

  // Visions connect-time repair: findings are current state, so one snapshot beats replay retention (plan-limits precedent); registered after registerControlHandlers so the snapshot frame stays first
  if (visionsLane) {
    controlWss.on('connection', (ws) => {
      if (ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify(visionsLane.snapshotMessage()));
      } catch (sendError) {
        console.warn(`[visions] connect-time snapshot send failed: ${sendError.message}`);
      }
    });
  }

  // Ingest connect-time repair, same reasoning and same shape: the activity deltas are deliberately not
  // replayable (server/control-replay-core.js), so one snapshot of the current rings repairs any client
  // that missed frames. Refused to a remote-trust socket for the same reason the deltas are.
  if (ingestLane) {
    controlWss.on('connection', (ws) => {
      if (ws.readyState !== 1) return;
      if (ws.glissaTrust === 'remote') return;
      try {
        ws.send(JSON.stringify(ingestLane.snapshotMessage()));
      } catch (sendError) {
        console.warn(`[ingest] connect-time snapshot send failed: ${sendError.message}`);
      }
    });
  }

  // --- Data WebSocket ---

  dataWss.on('connection', (ws, req) => {
    const sessionId = dataSessionIdFromUrl(req.url);
    if (sessionId === null) {
      ws.close(1008, 'Invalid session id');
      return;
    }
    const sess = getSessionAny(sessionId);

    if (!sess) {
      ws.close(1008, 'Session not found');
      return;
    }

    if (!sessionDataClients.has(sessionId)) {
      sessionDataClients.set(sessionId, new Map());
    }
    const viewerSizes = sessionDataClients.get(sessionId);
    viewerSizes.set(ws, null);

    // A viewer that stops looking (phone leaving the Terminal screen, card released back to its hidden
    // home) hands the PTY back to the most recent viewer still watching; its own client caches the size
    // it last sent and cannot re-assert on demand, so the server does it.
    function releaseViewerSize() {
      if (!viewerSizes.get(ws)) return;
      viewerSizes.set(ws, null);
      // The session was removed out from under us (closeSessionDataClients drops the whole map before
      // the close handlers run); resizing its PTY on the way out is meaningless.
      if (sessionDataClients.get(sessionId) !== viewerSizes) return;
      const successor = pickSizeAfterDeparture(viewerSizes, ws);
      if (!successor) return;
      sess.resize(successor.cols, successor.rows);
    }

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
        if (isApplicableViewerSize(cols, rows)) {
          nextViewerResizeSeq += 1;
          viewerSizes.set(ws, { cols, rows, resizeSeq: nextViewerResizeSeq });
          sess.resize(cols, rows, { redraw: msg.redraw === true });
        }
        return;
      }
      // The connection stays open (bytes keep flowing into the card's terminal); only this viewer's
      // claim on the PTY size is dropped.
      if (msg.type === 'unview') {
        releaseViewerSize();
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
      releaseViewerSize();
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
  // other listeners (e.g. Vite HMR) can handle them. Routing is by PATHNAME
  // (core/upgrade-route.js): the dashboard reconnects with `/control?since=<seq>`.

  function handleUpgrade(req, socket, head) {
    const route = classifyUpgradePath(req.url);
    const trust = classifyRequestOrigin({ localPort: socket.localPort, remoteListenerPort });

    // A visions route with no lane constructed takes the unknown-path branch, byte-identical to before the lane existed
    if (route === 'unknown' || (route === 'visions' && !visionsLane)) {
      // Locally, leave the socket alone so other upgrade listeners (Vite HMR) can claim it. On the
      // remote listener nothing else is listening, so returning would strand an authenticated-by-
      // nobody socket open with no timeout; close it instead.
      if (trust === 'remote') socket.destroy();
      return;
    }

    // Live editor buffers never cross the remote listener in v1, paired device or not (docs/archive/plan-navigator.md, Non-goals)
    if (route === 'visions' && trust === 'remote') {
      socket.destroy();
      return;
    }

    // Host rides along here too: the middleware above covers only the request path, and an upgrade
    // never reaches it.
    if (!decideHostAllowed(req.headers.host, allowedHosts)) {
      socket.destroy();
      return;
    }

    const authenticated = trust === 'remote' && remoteAuth ? remoteAuth.isUpgradeAuthorized(req) : false;
    // control and data are the two channels only the dashboard page opens, so they carry the extra
    // browser-shaped requirements: a mandatory Origin and the page token. The Visions relay is an
    // editor extension, not a browser, and keeps the old rules.
    const dashboardRoute = route === 'control' || route === 'data';
    const decision = decideUpgradeAccess({
      remoteEnabled: remote.enabled,
      trust,
      origin: req.headers.origin,
      allowedOrigins: remote.allowedOrigins,
      authenticated,
      listenerPorts: listenerPortsFor(socket),
      dashboardRoute,
      tokenOk: dashboardRoute ? tokenMatches(upgradeTokenFromUrl(req.url)) : false,
    });
    if (!decision.allow) {
      // A bare destroy() is what a rejected origin has always got, and remote-disabled builds must
      // stay byte-identical; the explicit status line is a remote-mode affordance so an unpaired
      // client sees why its socket died instead of a naked reset.
      if (remote.enabled) socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (route === 'control') {
      controlWss.handleUpgrade(req, socket, head, (ws) => {
        // Carry the listener-derived trust onto the connection: control-handlers.js reads it back to
        // send that client its `client-trust` frame, so the UI can stop offering actions that only
        // make sense on the machine Glissa runs on. Same invariant as the classifier - it comes from
        // the socket's local port, never from anything the client sent.
        ws.glissaTrust = trust;
        controlWss.emit('connection', ws, req);
      });
      return;
    }
    if (route === 'visions') {
      visionsLane.handleUpgrade(req, socket, head);
      return;
    }
    dataWss.handleUpgrade(req, socket, head, (ws) => {
      dataWss.emit('connection', ws, req);
    });
  }

  httpServer.on('upgrade', handleUpgrade);

  // --- Config hot-reload ---

  const stopConfigWatch = configStore.watchForChanges((newConfig) => {
    applyConfigReload(newConfig);
  });

  // --- Shutdown ---

  let shuttingDown = false;

  function shutdown() {
    if (shuttingDown) return { reaps: [], stoppers: [] };
    shuttingDown = true;
    // Every lane's async stop(), named and collected so server-lifecycle can AWAIT it under a bound
    // instead of firing it into the void. The stops still run synchronously from here (each clears its
    // timers and watchers on the spot), which is what keeps a caller that tears the backend down with
    // no coordinator - the Vite dev plugin, every backend test - behaving exactly as before.
    const stoppers = createStopperCollector();
    if (pendingAutoResumeOnListening) {
      httpServer.off('listening', pendingAutoResumeOnListening);
      pendingAutoResumeOnListening = null;
    }
    clearInterval(healthInterval);
    stopConfigWatch();
    // Same reason as stopConfigWatch: a leaked fs.watch keeps the event loop alive and hangs any
    // embedder that expects the process to exit.
    if (remoteAuth) remoteAuth.stop();
    try { if (updateAbort) updateAbort.abort(); } catch { /* no in-flight update request */ }
    if (updateRecheckInterval) clearInterval(updateRecheckInterval);
    // INVARIANT: destroy NotificationManager BEFORE sessions - clears all timers globally
    notificationManager.destroy();
    // Collect each session's in-flight PTY reap (set by kill() on every platform, see sessions.js: the
    // taskkill on win32, the bounded process-gone poll after a group SIGKILL off it) so the lifecycle
    // can await them before exit/respawn; a DORMANT session has no PTY and no reap.
    const pendingReaps = [];
    for (const [, sess] of sessions) {
      sess.destroy();
      if (sess._killReap) pendingReaps.push(sess._killReap);
    }
    // Blocks a restart still queued on the poller's restart chain (e.g. a settings save that raced
    // shutdown) from starting a fresh poller after the process has begun tearing down, and hands back
    // the in-flight drain (a review still discarding its worktree) for the coordinator to await.
    stoppers.add('pr-review', () => prReview.stopPoller());
    for (const [, sess] of reviewSessions) {
      sess.destroy();
      if (sess._killReap) pendingReaps.push(sess._killReap);
    }
    stoppers.add('posthog', () => posthog.stopPoller());
    // Closes the watchers and the sweep timer synchronously; the returned promise drains an in-flight
    // rebuild, which a restart must not race over the same published pack directory.
    stoppers.add('pack-service', () => packService.stop());
    // Clears the scan interval and the pending nudge, then drains whatever pass is mid-write: the
    // warehouse and budget-state files are exactly what a fresh backend would reopen.
    stoppers.add('usage', () => usage.stop());
    // Same treatment as the pack service: the timer goes synchronously, the returned promise drains an
    // in-flight distill, and the session below is destroyed regardless.
    stoppers.add('pack-distiller', () => packDistiller.stop());
    for (const [, sess] of distillSessions) {
      sess.destroy();
      if (sess._killReap) pendingReaps.push(sess._killReap);
    }
    for (const [, sess] of investigationSessions) {
      sess.destroy();
      if (sess._killReap) pendingReaps.push(sess._killReap);
    }
    // Cancels the batch timer and detaches every session tap; null whenever the lane is off. Ahead of
    // the Visions lane only because the taps ride sessions already destroyed above.
    if (ingestLane) stoppers.add('ingest', () => ingestLane.stop());
    // Drops every mirrored buffer and its pending sweep timer; null whenever the lane is off.
    if (visionsLane) stoppers.add('visions', () => visionsLane.stop());
    // Before the store: they drain their queued writes THROUGH that store.
    if (memoryIngest) stoppers.add('memory-ingest', () => memoryIngest.stop());
    if (memoryDistiller) stoppers.add('memory-distill', () => memoryDistiller.stop());
    // Drains the pending append and projection writes; null whenever memory is off.
    if (memoryStore) stoppers.add('memory-store', () => memoryStore.stop());
    // Not a lane, but the same rule: an outbox write still in flight is what makes a queued phone ping
    // survive the restart it was queued during.
    stoppers.add('telegram-outbox', () => telegramOutbox.idle());
    for (const [, sess] of [...visionsSessions, ...memoryDistillSessions]) {
      sess.destroy();
      if (sess._killReap) pendingReaps.push(sess._killReap);
    }
    heartbeat.stop();
    controlWss.close();
    dataWss.close();
    return { reaps: pendingReaps, stoppers: stoppers.entries() };
  }

  // --- Update check ---
  // Fire-and-forget: NEVER awaited, so a slow/hung registry can't delay boot. The terminal .catch is
  // load-bearing - surface() calls console.log + broadcastControl, and this process has no
  // uncaughtException handler, so a throw here would become an unhandledRejection that crashes it.
  // Primary dev-nag guard is the release compare itself; isLocalConfig is a best-effort secondary skip.
  // checkForUpdate is injectable so a boot test can drive it with a stub instead of hitting the network.
  const runUpdateCheck = options.checkForUpdate || defaultCheckForUpdate;
  function surfaceUpdate(result) {
    if (!result || !result.updateAvailable) return;
    // A server left running for weeks rechecks daily; only a different release is news.
    const alreadySurfaced = Boolean(updateStatus)
      && (updateStatus.latest || updateStatus.latestSha) === (result.latest || result.latestSha);
    updateStatus = result;
    if (alreadySurfaced) return;
    const from = result.current || 'unknown';
    const to = result.latest || shortSha(result.latestSha) || 'unknown';
    console.log(`[update] A newer glissa is available: ${from} -> ${to}. Update: ${result.command}`);
    broadcastControl({ type: 'update-available', ...result });
  }
  if (config.checkForUpdates !== false && !configStore.isLocalConfig) {
    const currentVersion = require('../package.json').version;
    const runAndSurfaceUpdate = () => {
      updateAbort = new AbortController();
      return runUpdateCheck({ currentVersion, abortController: updateAbort })
        .then(surfaceUpdate)
        .catch(() => { /* advisory only - never let the update check affect the process */ });
    };
    void runAndSurfaceUpdate();
    // A long-lived server would otherwise report the tip it saw at boot forever. Skipped with no
    // dashboard connected: nobody is there to read a banner, and the boot result already covers the
    // next connect via getUpdateStatus.
    updateRecheckInterval = setInterval(() => {
      if (controlWss.clients.size === 0) return;
      void runAndSurfaceUpdate();
    }, UPDATE_RECHECK_MS);
    updateRecheckInterval.unref();
  }

  // attach() wires the SAME Express app and upgrade handler onto the remote listener's HTTP server.
  // Sharing them is what makes the two listeners identical except for the trust classification, so a
  // route can never exist on one and be forgotten on the other. The Vite dev plugin never calls it,
  // which is why remote mode is inert in dev by design.
  return {
    shutdown,
    port,
    app,
    // A session by id. The maps themselves stay closed over; this is the one
    // read-only way in for an embedder (and for the route tests, which have no other way to hold the
    // Session a request will act on).
    getSession: getSessionAny,
    // The freshest official plan-limit snapshot, for the same reason getSession is exposed: a route
    // test has no other way to observe what a hook callback stored.
    getPlanLimits: () => usage.getPlanLimitsMessage(),
    // The visions lane itself (null when off), exposed for the same reason getSession is: a booted
    // backend gives a test no other way to drive what a dispatch result would do to the intent model.
    getVisionsLane: () => visionsLane,
    // The ingest lane (null when off), exposed for the same reason: a booted backend gives a test no
    // other way to observe what a session tap put in the rings.
    getIngestLane: () => ingestLane,
    // The memory ingest consumer (null when off), same reason as the two handles beside it.
    getMemoryIngest: () => memoryIngest,
    // The memory store (null when off), exposed for the same reason: a booted backend gives a test no
    // other way to observe that a default config constructed nothing.
    getMemoryStore: () => memoryStore,
    // The memory-distill lane (null when off), same reason.
    getMemoryDistiller: () => memoryDistiller,
    bindHost: bindDecision.host,
    remote: {
      enabled: remote.enabled,
      port: remote.port,
      publicHost: remote.publicHost,
      attach(remoteHttpServer) {
        remoteHttpServer.on('request', app);
        remoteHttpServer.on('upgrade', handleUpgrade);
      },
    },
  };
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

  // Sent as a FILE, unlike the states route above: that one regenerates its module from a require()d
  // object, which works because states exports nothing but constants. This module exports functions,
  // and a required function cannot be serialized back into source, so the ESM twin ships as-is.
  app.get('/shared/client-trust.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, '..', 'shared/client-trust.esm.js'));
  });
}

module.exports = {
  createBackend, runAutoResume, persistSessionField, decideWasActiveFlip, carryWorktreeAcrossRecreate,
  reconcileSessionWorktrees, shouldStartAfterModify,
};
