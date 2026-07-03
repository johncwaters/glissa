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

// Bounded wait for the pending PTY reaps a shutdown started, so the process does not exit (or respawn)
// before taskkill has reaped the cmd/claude/conhost tree. Capped so a child that resists kill cannot
// hang the lifecycle. Returns a promise that always resolves.
function awaitReaps(pendingReaps, { capMs = 3000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (!Array.isArray(pendingReaps) || pendingReaps.length === 0) return Promise.resolve();
  let timer;
  const cap = new Promise((resolve) => {
    timer = setTimeoutFn(resolve, capMs);
    if (timer && timer.unref) timer.unref();
  });
  return Promise.race([Promise.allSettled(pendingReaps), cap]).then(() => clearTimeoutFn(timer));
}

// Build the restart/shutdown handlers. Every side effect is injected so the ordering and flags can be
// asserted without launching a real process:
//   shutdown      - tears the backend down; returns an array of in-flight PTY reap promises to await.
//   httpServer    - { close(cb) }: closes the listener, then runs cb (spawn-and-exit / exit).
//   onRestart     - dev (Vite) restarts in-process via this; when null, production respawns detached.
//   spawn         - child_process.spawn (the production respawn); defaults to require at call sites.
//   exit/getArgv/cwd - process seams (defaulted to process.*) so tests observe instead of exiting.
function createLifecycle({
  shutdown,
  httpServer,
  onRestart = null,
  spawn,
  exit = process.exit,
  getArgv = () => process.argv,
  cwd = () => process.cwd(),
  capMs = 3000,
  closeTimeoutMs = 2000,
}) {
  // Single re-entry guard across BOTH transitions: once a restart or shutdown is underway, any further
  // restart/shutdown message is ignored, so a double click can never spawn a second replacement.
  let requested = false;

  function fallbackTimer(fn) {
    const t = setTimeout(fn, closeTimeoutMs);
    if (t && t.unref) t.unref();
    return t;
  }

  async function requestShutdown() {
    if (requested) return;
    requested = true;
    const pendingReaps = shutdown() || [];
    await awaitReaps(pendingReaps, { capMs });
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
    // Production: close the listener so the port is released, then spawn the replacement and exit.
    // detached so it outlives this process; windowsHide so it does NOT pop its own console window
    // (mirrors the openInEditor spawn in backend.js). The spawned guard makes the close-cb and the
    // fallback timer idempotent (exactly one respawn).
    let spawned = false;
    const spawnAndExit = () => {
      if (spawned) return;
      spawned = true;
      const argv = getArgv();
      spawn(argv[0], argv.slice(1), {
        cwd: cwd(),
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }).unref();
      exit(0);
    };
    httpServer.close(spawnAndExit);
    fallbackTimer(spawnAndExit);
  }

  return { requestShutdown, requestRestart };
}

module.exports = { awaitReaps, createLifecycle };
