'use strict';

// Headroom proxy supervisor: the stateful shell around the pure lifecycle core in
// session-core/headroom-core.js. Detects an externally installed Headroom CLI, spawns
// `headroom proxy` on demand, watches readiness via the injected /livez probe, and reports
// everything as 'status' events (NEVER a bare 'error' event: a missing listener must not be
// able to crash the server, so failures ride the status payload as state:'failed' + logTail).
//
// Headroom is NOT a dependency. Glissa only supervises a binary the user installed themselves;
// when nothing is installed the service parks in 'not-installed' and every start is a no-op.
//
// Trust boundary: start/stop arrive over the unauthenticated localhost control WS (same level
// as add-session spawning claude). The child is ALWAYS spawned with an args ARRAY and
// shell:false; the port is re-validated in buildProxyArgs, so no user-controlled string ever
// reaches a command line. An external proxy (something already answering /livez) is adopted,
// never killed: the pure table forbids stop from running-external.

const { EventEmitter } = require('node:events');
const {
  nextState,
  candidateCommands,
  buildProxyArgs,
  DEFAULT_HEADROOM_PORT,
} = require('./session-core/headroom-core');

const LOG_RING_MAX = 100; // last N output lines kept for the failed-state tail
const READY_POLL_MS = 1000; // /livez poll cadence while starting
const READY_BUDGET_MS = 60000; // Headroom cold start (transformers/onnx import) can be slow
const KILL_GRACE_MS = 5000; // child.kill() grace before the taskkill /T /F tree-kill
const DETECT_TIMEOUT_MS = 10000; // per-candidate `headroom --version` budget

// All deps are injectable for tests. Production wiring (backend.js) passes the real
// child_process.spawn/execFile and an http.get-based probe.
//   getConfig: () => config snapshot (reads headroomPort at call time)
//   spawn:     child_process.spawn signature
//   execFile:  child_process.execFile signature (callback style)
//   probe:     async (port) => boolean ("does /livez answer 200")
//   log:       console.log-compatible
// opts.timings lets tests shrink the poll/budget/grace intervals to milliseconds; production
// callers omit it and get the constants above.
function createHeadroomService({ getConfig, spawn, execFile, probe, log = () => {}, timings = {} }) {
  const readyPollMs = timings.readyPollMs ?? READY_POLL_MS;
  const readyBudgetMs = timings.readyBudgetMs ?? READY_BUDGET_MS;
  const killGraceMs = timings.killGraceMs ?? KILL_GRACE_MS;
  const svc = new EventEmitter();

  let state = 'not-installed';
  let child = null; // the OWNED child (never set for running-external)
  let resolved = null; // cached { file, args } detection result
  let version = null;
  let lastError = null;
  let pollTimer = null;
  let killTimer = null;
  let busy = false; // serializes start() (probe-then-spawn has an await gap)
  let disposed = false; // teardown latch: an in-flight async poll tick must die quietly
  const ring = [];

  function port() {
    const cfg = getConfig() || {};
    const p = cfg.headroomPort;
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) return p;
    return DEFAULT_HEADROOM_PORT;
  }

  function pushLines(buf) {
    const lines = String(buf).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      ring.push(line);
      if (ring.length > LOG_RING_MAX) ring.shift();
    }
  }

  function getStatus() {
    return {
      state,
      port: port(),
      pid: child ? child.pid : null,
      version,
      error: lastError,
      logTail: ring.slice(-15),
    };
  }

  // Single chokepoint: every state change goes through the pure table. An illegal event is a
  // refused no-op (returns false) so callers can guard without duplicating lifecycle rules.
  function apply(event) {
    const next = nextState(state, event);
    if (!next) return false;
    // A self-transition (detect-missing while already not-installed) still emits: the boot
    // detect-miss is what hydrates the chip's not-installed hint.
    state = next;
    svc.emit('status', getStatus());
    return true;
  }

  function clearPoll() {
    if (!pollTimer) return;
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function clearKillTimer() {
    if (!killTimer) return;
    clearTimeout(killTimer);
    killTimer = null;
  }

  function unrefd(fn, ms) {
    const t = setTimeout(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  // Try one candidate's `--version`. Resolves { ok, stdout }.
  function tryCandidate(cand) {
    return new Promise((resolve) => {
      try {
        execFile(
          cand.file,
          [...cand.args, '--version'],
          { timeout: DETECT_TIMEOUT_MS, windowsHide: true },
          (err, stdout) => {
            if (err) { resolve({ ok: false }); return; }
            resolve({ ok: true, stdout: String(stdout || '') });
          },
        );
      } catch {
        resolve({ ok: false });
      }
    });
  }

  // Walk the candidate list. A miss (missing binary, execFile throw, or timeout) is
  // 'not-installed', NEVER 'failed': failed is reserved for a present binary whose proxy broke.
  async function detect() {
    for (const cand of candidateCommands(process.env)) {
      const r = await tryCandidate(cand);
      if (!r.ok) continue;
      resolved = { file: cand.file, args: cand.args };
      const m = r.stdout.match(/version\s+([\d.]+)/i);
      version = m ? m[1] : null;
      log(`[headroom] detected: ${cand.file}${version ? ` v${version}` : ''}`);
      apply('detect-ok');
      return true;
    }
    resolved = null;
    version = null;
    apply('detect-missing');
    return false;
  }

  function wireChild(c) {
    if (c.stdout) c.stdout.on('data', pushLines);
    if (c.stderr) c.stderr.on('data', pushLines);
    c.on('error', (err) => {
      // spawn-level failure (ENOENT, EACCES). Same handling as an early exit.
      pushLines(`spawn error: ${err.message}`);
      onChildGone(1);
    });
    c.on('exit', (code) => { onChildGone(code); });
  }

  // One funnel for "the owned child is gone", whatever the path (clean exit, crash, kill,
  // spawn error). The pure table decides what the death means in the current state.
  async function onChildGone(code) {
    if (disposed) return; // teardown kill: no re-probe, no transitions, no emits
    clearPoll();
    clearKillTimer();
    child = null;
    if (state === 'stopping') {
      apply(code === 0 ? 'exit-clean' : 'exit-crash'); // both resolve to stopped
      return;
    }
    if (state === 'starting') {
      // EADDRINUSE usually surfaces as an early exit, not a spawn error. Re-probe once:
      // a 200 means a sibling Glissa won the startup race; adopt its proxy instead of failing.
      const external = await probeSafe();
      if (disposed) return; // disposed during the await: no transitions, no emits
      if (external && apply('probe-external')) return;
      lastError = lastError || `proxy exited (code ${code}) before becoming ready`;
      apply('exit-crash');
      return;
    }
    if (state === 'running') {
      if (code === 0) { apply('exit-clean'); return; }
      lastError = `proxy exited unexpectedly (code ${code})`;
      apply('exit-crash');
      return;
    }
    // failed/stopped/external: nothing legal to do; the table refuses and that is correct.
  }

  async function probeSafe() {
    try {
      return !!(await probe(port()));
    } catch {
      return false;
    }
  }

  // Tree-kill the child's whole process group: uvicorn can hold a worker tree that survives a
  // soft kill. Last resort on every kill path; failure leaves the exit handler as the only hope.
  function taskkillTree(c) {
    try {
      execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } catch { /* taskkill unavailable */ }
  }

  // Soft kill, then escalate to the tree-kill after the grace period. Shared by stop() and the
  // readiness-budget expiry so a kill-resistant tree can never wedge the supervisor: the
  // escalation forces the exit event that drives the table transition.
  function killChild(c) {
    try { c.kill(); } catch { /* already gone */ }
    killTimer = unrefd(() => {
      killTimer = null;
      if (child !== c) return; // exit handler already ran
      taskkillTree(c);
    }, killGraceMs);
  }

  function startReadyPoll() {
    const deadline = Date.now() + readyBudgetMs;
    const tick = async () => {
      pollTimer = null;
      if (disposed) return;
      if (state !== 'starting') return;
      const up = await probeSafe();
      if (disposed) return; // dispose() does not change state, so the latch is the only guard
      if (state !== 'starting') return; // stopped during the await
      if (up) { lastError = null; apply('ready'); return; }
      if (Date.now() >= deadline) {
        lastError = `proxy did not answer /livez within ${readyBudgetMs / 1000}s`;
        const c = child;
        // killChild escalates to the tree-kill, so even a kill-resistant proxy produces an exit;
        // onChildGone (state still 'starting') then re-probes and lands in failed.
        if (c) { killChild(c); return; }
        // already-dead edge: no exit event will come, force the table transition ourselves.
        apply('exit-crash');
        return;
      }
      pollTimer = unrefd(tick, readyPollMs);
    };
    pollTimer = unrefd(tick, readyPollMs);
  }

  async function start() {
    if (disposed) return getStatus();
    if (busy) return getStatus();
    busy = true;
    try {
      if (state === 'starting' || state === 'running' || state === 'running-external' || state === 'stopping') {
        return getStatus();
      }
      // Probe BEFORE spawning: something already answering /livez is adopted, not shadowed.
      if (await probeSafe()) {
        apply('probe-external');
        return getStatus();
      }
      if (!resolved) await detect();
      if (state === 'not-installed') return getStatus();
      if (!apply('spawn')) return getStatus();
      lastError = null;
      ring.length = 0;
      const args = [...resolved.args, ...buildProxyArgs(port())];
      try {
        child = spawn(resolved.file, args, { shell: false, windowsHide: true });
      } catch (err) {
        pushLines(`spawn threw: ${err.message}`);
        child = null;
        const external = await probeSafe();
        if (external && apply('probe-external')) return getStatus();
        lastError = err.message;
        apply('exit-crash');
        return getStatus();
      }
      log(`[headroom] spawned ${resolved.file} ${args.join(' ')} (pid ${child.pid})`);
      wireChild(child);
      startReadyPoll();
      return getStatus();
    } finally {
      busy = false;
    }
  }

  function stop() {
    if (state === 'running-external') {
      return { ok: false, error: 'Headroom proxy is external (not started by Glissa); not stopping it' };
    }
    if (!apply('stop')) return { ok: false, error: `cannot stop from state "${state}"` };
    clearPoll();
    const c = child;
    if (!c) {
      // failed -> stopped: no child to kill, the table transition already happened.
      return { ok: true };
    }
    killChild(c);
    return { ok: true };
  }

  // Server teardown: kill the OWNED child only (an external proxy is not ours to reap).
  // Graceful-shutdown-only by design; an ungraceful crash orphans the proxy and the next boot
  // re-adopts it as running-external (documented limitation, same class as PTY orphans).
  function dispose() {
    disposed = true;
    clearPoll();
    clearKillTimer();
    const c = child;
    child = null;
    if (!c) return;
    // No grace on teardown: soft kill and tree-kill immediately, best effort.
    try { c.kill(); } catch { /* already gone */ }
    taskkillTree(c);
  }

  svc.detect = detect;
  svc.start = start;
  svc.stop = stop;
  svc.dispose = dispose;
  svc.getStatus = getStatus;
  return svc;
}

module.exports = { createHeadroomService };
