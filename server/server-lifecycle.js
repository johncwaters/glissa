'use strict';

// Server lifecycle (restart / shutdown), extracted from backend.js so the re-entry guard, the
// reap-before-exit ordering, and the detached-respawn spawn flags are unit-testable behind injected
// side effects (mirrors the spawnCommand/ptySpawn/killProc seams in sessions.js). No backend state
// here; createBackend wires its shutdown(), httpServer, and the child_process spawn into it.
//
// WHY this exists: a menu restart used to spawn the replacement DETACHED with no windowsHide (its own
// console window, separate process group => invisible and unkillable by closing the visible window),
// with no re-entry guard (two restart messages => two replacements => a config-reload respawn storm),
// and it exited BEFORE the async taskkill reaped the PTY tree (orphaned cmd/claude/conhost). The guard
// + windowsHide + awaited reap below close all three.

const { decideRestartStrategy, SUPERVISED_RESTART_EXIT_CODE } = require('./core/restart-strategy');

// Bounded wait for the pending PTY reaps a shutdown started, so the process does not exit (or respawn)
// before taskkill has reaped the cmd/claude/conhost tree. Capped so a child that resists kill cannot
// hang the lifecycle. Returns a promise that always resolves.
// The cap timer is deliberately NOT unref'd: when a reap hangs it is the only thing that settles the
// returned promise, so an unref'd timer lets the loop drain and leaves the awaiting caller hanging
// instead of proceeding. It is cleared as soon as the race settles, so it pins the loop only while a
// reap is genuinely outstanding, bounded by capMs.
function awaitReaps(pendingReaps, { capMs = 3000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (!Array.isArray(pendingReaps) || pendingReaps.length === 0) return Promise.resolve();
  let timer;
  const cap = new Promise((resolve) => {
    timer = setTimeoutFn(resolve, capMs);
  });
  return Promise.race([Promise.allSettled(pendingReaps), cap]).then(() => clearTimeoutFn(timer));
}

// Build the restart/shutdown handlers. Every side effect is injected so the ordering and flags can be
// asserted without launching a real process:
//   shutdown      - tears the backend down; returns an array of in-flight PTY reap promises to await.
//   httpServer    - { close(cb) }: closes the listener, then runs cb (spawn-and-exit / exit).
//   onRestart     - dev (Vite) restarts in-process via this; when null, production respawns detached.
//   spawn         - child_process.spawn (the production respawn); defaults to require at call sites.
//   exit/getArgv/cwd/env - process seams (defaulted to process.*) so tests observe instead of exiting.
// Secondary listeners (remote mode's cookie-gated server) are closed alongside the primary, with
// their sockets forced shut: the primary's close is what gates exit, and a lingering remote listener
// would keep its port bound past a restart's respawn.
function closeExtraServers(extraServers) {
  for (const server of extraServers) {
    try { server.close(); } catch { /* not listening */ }
    try { if (server.closeAllConnections) server.closeAllConnections(); } catch { /* older node */ }
  }
}

function createLifecycle({
  shutdown,
  httpServer,
  extraServers = [],
  onRestart = null,
  spawn,
  exit = process.exit,
  getArgv = () => process.argv,
  cwd = () => process.cwd(),
  env = process.env,
  log = console.log,
  capMs = 3000,
  closeTimeoutMs = 2000,
}) {
  // Single re-entry guard across BOTH transitions: once a restart or shutdown is underway, any further
  // restart/shutdown message is ignored, so a double click can never spawn a second replacement.
  let requested = false;

  function fallbackTimer(fn) {
    const t = setTimeout(fn, closeTimeoutMs);
    if (t?.unref) t.unref();
    return t;
  }

  async function requestShutdown() {
    if (requested) return;
    requested = true;
    const pendingReaps = shutdown() || [];
    await awaitReaps(pendingReaps, { capMs });
    closeExtraServers(extraServers);
    let exited = false;
    const doExit = () => {
      if (exited) return;
      exited = true;
      exit(0);
    };
    httpServer.close(() => {
      console.log('Server closed - exiting.');
      doExit();
    });
    fallbackTimer(doExit);
  }

  async function requestRestart() {
    if (requested) return;
    requested = true;
    const pendingReaps = shutdown() || [];
    await awaitReaps(pendingReaps, { capMs });
    closeExtraServers(extraServers);
    // Dev mode (Vite) restarts the server in-process; no detached respawn, no new console window.
    // Release the guard and rethrow if the in-process restart throws, so a thrown onRestart does not
    // latch `requested` and permanently no-op every later restart/shutdown. Production never reaches
    // here (it exits below), so the guard latching on the production path is moot by design.
    if (onRestart) {
      try {
        onRestart();
      } catch (err) {
        requested = false;
        throw err;
      }
      return;
    }
    // Production: close the listener so the port is released, then hand off to the replacement. WHO
    // starts that replacement depends on whether anything supervises this process (see
    // core/restart-strategy.js): under systemd the self-respawn silently bricks the service, so the
    // process exits NON-ZERO and lets `Restart=on-failure` start the unit again. Unsupervised, the
    // original respawn is the only thing that can bring Glissa back, so it is kept verbatim: detached
    // so it outlives this process, windowsHide so it does NOT pop its own console window. Shutdown
    // stays exit 0 in BOTH worlds - "Shut Down" must stay
    // down, and a zero exit is what keeps `Restart=on-failure` from reviving it.
    const strategy = decideRestartStrategy(env);
    let handedOff = false;
    // Idempotent across the close callback and the fallback timer (exactly one hand-off).
    const handOffAndExit = () => {
      if (handedOff) return;
      handedOff = true;
      if (strategy === 'exit-for-supervisor') {
        log(`[lifecycle] Supervised by systemd - exiting ${SUPERVISED_RESTART_EXIT_CODE} so the supervisor restarts the unit`);
        exit(SUPERVISED_RESTART_EXIT_CODE);
        return;
      }
      const argv = getArgv();
      spawn(argv[0], argv.slice(1), {
        cwd: cwd(),
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }).unref();
      exit(0);
    };
    httpServer.close(handOffAndExit);
    fallbackTimer(handOffAndExit);
  }

  return { requestShutdown, requestRestart };
}

module.exports = { awaitReaps, createLifecycle };
