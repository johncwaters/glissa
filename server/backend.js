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
const { STATES } = require('../shared/states');
const { isSameDirectoryPath } = require('../shared/paths');
const { createConfigStore, generateProjectId, ensureProjectIds, DEFAULT_CONFIG } = require('./config-store');
const { registerControlHandlers } = require('./control-handlers');
const { createReplayLog } = require('./control-replay-core');
const { createLifecycle } = require('./server-lifecycle');
const { NotificationManager } = require('../notifications/notification-manager');
const { createNotifyGate, explainNotification } = require('../session/core/notify-gate');
const { pickAutoResume } = require('../session/core/auto-resume');
const { createTelegramChannel } = require('../notifications/channels/telegram');
const { createToastChannel } = require('../notifications/channels/toast');
const { createWebNotificationChannel } = require('../notifications/channels/web-notification');
const { createRecorder } = require('../session/session-recorder');
const { createWsSender } = require('./ws-sender');
const { HookRouter } = require('../detection/hook-source');
const { sweepOrphans } = require('../detection/settings-injector');
const { checkForUpdate: defaultCheckForUpdate } = require('./update-check');
const { createSpawnGate } = require('./spawn-gate');
const { spawn } = require('./child-process-safe');
const { createGitWorkspace, createGitWorkspaceSync } = require('./git-workspace');
const { runPostTurnChecks, resolveCheckConfig } = require('./post-turn-checker');
const { createIntegrationRefWatcher } = require('../detection/integration-ref-watch');
const { createIntegrationWatcherPool } = require('../detection/integration-watcher-pool');
const { createPrReviewWiring } = require('./pr-review-wiring');
const { createPosthogWiring } = require('./posthog-wiring');
const { normalizeRemoteConfig, validateRemoteConfig, decideBindHost } = require('./core/remote-config');
const { createClientPresence } = require('./core/client-presence');
const { classifyUpgradePath, dataSessionIdFromUrl } = require('./core/upgrade-route');
const { classifyRequestOrigin, decideUpgradeAccess } = require('./core/request-trust');
const { isApplicableViewerSize, pickSizeAfterDeparture } = require('./core/viewer-size-core');
const { createRemoteAuth } = require('./remote-auth');
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
      // back on review. Ephemeral lane sessions are built elsewhere (not makeSession), so they never
      // receive this and run as they did before.
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
    const captureConfig = { ...(cfg.capture || {}), baseDir: path.join(path.dirname(configStore.configPath), 'recordings') };
    const recorder = createRecorder(project.name, captureConfig, cfg.recordSignals ?? DEFAULT_CONFIG.recordSignals);
    if (recorder) {
      session.setRecorder(recorder);
    }
    return session;
  }

  // --- Express setup ---

  const app = express();

  // Remote gate FIRST, ahead of every route including /hook: a remote-classified request is refused
  // before any handler sees it. The middleware self-exempts /pair/*, which mountPairRoutes serves.
  if (remoteAuth) {
    app.use(remoteAuth.httpMiddleware);
    remoteAuth.mountPairRoutes(app);
  }

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
      res.status(out.status).json({ ok: out.status === 200, reason: out.reason });
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
    for (const sess of [...sessions.values(), ...reviewSessions.values(), ...investigationSessions.values()]) {
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
        if (stats.dataListenerCount !== clientCount) listenerMismatch = true;
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
  // Off-dashboard channel: reaches the operator's phone when NO dashboard tab is open anywhere, so
  // the web channel's broadcast would land on nobody. Registered unconditionally and gated per
  // delivery off live config (telegramNotifications + the telegram credentials the PR lane already
  // defines), so the toggle needs no restart and no re-registration. Absent key = never sends.
  notificationManager.registerChannel('telegram', createTelegramChannel({
    getConfig: () => config,
    getConnectionCount: () => clientPresence.connectionCount(),
  }));

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
  const gitWorkspace = createGitWorkspace();

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
  const prReview = createPrReviewWiring({
    config, reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, gitWorkspace,
    getProjectPathById, getProjectNameById,
    broadcast: (msg) => broadcastControl(msg),
  });

  // PostHog monitoring lane (server/posthog-wiring.js): inert unless config.posthog.enabled and
  // config.telegram are both set. Same lifecycle as the PR lane - started at boot below, restarted on
  // a posthog/telegram settings change, stopped in shutdown().
  const posthog = createPosthogWiring({
    config, investigationSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate,
    broadcast: (msg) => broadcastControl(msg),
  });

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
    // async `gitWorkspace` is reserved for the recurring session and PR-review paths.
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

  // --- GitHub PR auto-review poller (opt-in; inert unless config.prReview.enabled) ---
  prReview.startPoller();

  // --- PostHog monitoring poller (opt-in; inert unless config.posthog.enabled) ---
  posthog.startPoller();

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
    // Same gating for the PostHog lane: no-op unless this save changed config.posthog/telegram.
    posthog.restartIfConfigChanged();
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
    // Cached last PostHog tick summary, replayed to a client that connects between ticks.
    getPosthogStatus: () => posthog.getStatus(),
    // Per-issue Radar action: the one PostHog write (resolve/suppress).
    posthogSetIssueStatus: (args) => posthog.setIssueStatus(args),
    // Investigations inbox: archive one completed record (cached-status patch + rebroadcast).
    posthogArchiveInvestigation: (args) => posthog.archiveInvestigation(args),
    // Same for the PR auto-review lane.
    getPrStatus: () => prReview.getStatus(),
  });

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
          sess.resize(cols, rows);
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

    if (route === 'unknown') {
      // Locally, leave the socket alone so other upgrade listeners (Vite HMR) can claim it. On the
      // remote listener nothing else is listening, so returning would strand an authenticated-by-
      // nobody socket open with no timeout; close it instead.
      if (trust === 'remote') socket.destroy();
      return;
    }

    const authenticated = trust === 'remote' && remoteAuth ? remoteAuth.isUpgradeAuthorized(req) : false;
    const decision = decideUpgradeAccess({
      remoteEnabled: remote.enabled,
      trust,
      origin: req.headers.origin,
      allowedOrigins: remote.allowedOrigins,
      authenticated,
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
    if (shuttingDown) return [];
    shuttingDown = true;
    if (pendingAutoResumeOnListening) {
      httpServer.off('listening', pendingAutoResumeOnListening);
      pendingAutoResumeOnListening = null;
    }
    clearInterval(healthInterval);
    stopConfigWatch();
    // Same reason as stopConfigWatch: a leaked fs.watch keeps the event loop alive and hangs any
    // embedder that expects the process to exit.
    if (remoteAuth) remoteAuth.stop();
    try { updateAbort.abort(); } catch { /* no in-flight update request */ }
    // INVARIANT: destroy NotificationManager BEFORE sessions - clears all timers globally
    notificationManager.destroy();
    integrationPool.stopAll();
    // Collect each session's in-flight PTY reap (set by kill() on win32, see sessions.js) so the
    // lifecycle can await them before exit/respawn; a DORMANT session has no PTY and no reap.
    const pendingReaps = [];
    for (const [, sess] of sessions) {
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
    posthog.stopPoller();
    for (const [, sess] of investigationSessions) {
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
  reconcileSessionWorktrees,
};
