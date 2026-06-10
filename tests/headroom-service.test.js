'use strict';

// Tests for the Headroom supervisor shell (headroom-service.js) with every I/O dependency
// injected: fake spawn/execFile/probe and millisecond timings. The pure lifecycle rules are
// covered by headroom-core.test.js; these cases assert the orchestration around them
// (detection walk, probe-before-spawn adoption, readiness poll, EADDRINUSE race re-probe,
// kill escalation, dispose semantics, and the status-only event contract).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createHeadroomService } = require('../headroom-service');

const FAST = { readyPollMs: 5, readyBudgetMs: 200, killGraceMs: 20 };

function makeChild({ pid = 4242, exitOnKill = true } = {}) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = pid;
  c.kills = [];
  c.kill = () => {
    c.kills.push(Date.now());
    if (exitOnKill) setImmediate(() => c.emit('exit', 0));
  };
  return c;
}

// execFile fake: routes `--version` probes per `installed`, records taskkill invocations.
function makeExecFile({ installed = true, taskkillExits = null } = {}) {
  const calls = { detect: [], taskkill: [] };
  function execFile(file, args, opts, cb) {
    if (file === 'taskkill') {
      calls.taskkill.push(args);
      if (taskkillExits) setImmediate(taskkillExits);
      cb(null, '');
      return;
    }
    calls.detect.push(file);
    if (!installed) { setImmediate(() => cb(new Error('ENOENT'))); return; }
    setImmediate(() => cb(null, 'headroom, version 0.24.0'));
  }
  return { execFile, calls };
}

// probe fake driven by a mutable answers object: { value } read at call time.
function makeProbe(answers) {
  const probeCalls = [];
  return {
    probeCalls,
    probe: async (port) => {
      probeCalls.push(port);
      return answers.value;
    },
  };
}

function makeService(overrides = {}) {
  const answers = { value: false };
  const exec = makeExecFile(overrides.exec || {});
  const { probe, probeCalls } = makeProbe(answers);
  const spawned = [];
  const child = overrides.child || makeChild();
  const spawn = overrides.spawn || ((file, args, opts) => {
    spawned.push({ file, args, opts });
    return child;
  });
  const statuses = [];
  const events = [];
  const svc = createHeadroomService({
    getConfig: () => ({ headroomPort: overrides.port ?? 8787 }),
    spawn,
    execFile: exec.execFile,
    probe,
    timings: FAST,
  });
  const origEmit = svc.emit.bind(svc);
  svc.emit = (name, payload) => {
    events.push(name);
    if (name === 'status') statuses.push(payload.state);
    return origEmit(name, payload);
  };
  return { svc, answers, exec, probeCalls, spawned, child, statuses, events };
}

function waitFor(fn, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) { resolve(); return; }
      if (Date.now() - t0 > timeoutMs) { reject(new Error('waitFor timed out')); return; }
      setTimeout(tick, 2);
    };
    tick();
  });
}

test('detect miss (missing binary) -> not-installed; start() never spawns', async () => {
  const h = makeService({ exec: { installed: false } });
  assert.equal(await h.svc.detect(), false);
  assert.equal(h.svc.getStatus().state, 'not-installed');
  await h.svc.start();
  assert.equal(h.spawned.length, 0, 'spawn must not be called when nothing is installed');
  assert.equal(h.svc.getStatus().state, 'not-installed');
});

test('detect walks the candidate list and caches the hit', async () => {
  const h = makeService();
  assert.equal(await h.svc.detect(), true);
  assert.equal(h.svc.getStatus().state, 'stopped');
  assert.equal(h.svc.getStatus().version, '0.24.0');
  assert.ok(h.exec.calls.detect.length >= 1);
});

test('start adopts an already-running proxy as running-external without spawning', async () => {
  const h = makeService();
  await h.svc.detect();
  h.answers.value = true; // /livez answers before any spawn
  await h.svc.start();
  assert.equal(h.svc.getStatus().state, 'running-external');
  assert.equal(h.spawned.length, 0);
});

test('start spawns args-array with shell:false windowsHide:true and reaches running via the poll', async () => {
  const h = makeService();
  await h.svc.detect();
  await h.svc.start();
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].file, h.exec.calls.detect[0]);
  assert.deepEqual(h.spawned[0].args.slice(-3), ['proxy', '--port', '8787']);
  assert.equal(h.spawned[0].opts.shell, false);
  assert.equal(h.spawned[0].opts.windowsHide, true);
  assert.equal(h.svc.getStatus().state, 'starting');
  h.answers.value = true; // proxy comes up
  await waitFor(() => h.svc.getStatus().state === 'running');
  assert.deepEqual(h.statuses.includes('starting') && h.statuses.includes('running'), true);
});

test('EADDRINUSE race: early exit + re-probe 200 adopts running-external, not failed', async () => {
  const h = makeService();
  await h.svc.detect();
  await h.svc.start();
  h.answers.value = true; // sibling bound the port and now answers
  h.child.stderr.emit('data', 'error while attempting to bind on address: address already in use\n');
  h.child.emit('exit', 1);
  await waitFor(() => h.svc.getStatus().state === 'running-external');
  assert.equal(h.svc.getStatus().pid, null);
});

test('early exit with no sibling -> failed with the stderr tail', async () => {
  const h = makeService();
  await h.svc.detect();
  await h.svc.start();
  h.child.stderr.emit('data', 'ModuleNotFoundError: fastapi\n');
  h.child.emit('exit', 1);
  await waitFor(() => h.svc.getStatus().state === 'failed');
  const st = h.svc.getStatus();
  assert.ok(st.logTail.some((l) => l.includes('fastapi')));
  assert.ok(st.error, 'failed state must carry an error message');
});

test('crash while running -> failed; clean exit while running -> stopped', async () => {
  const h = makeService();
  await h.svc.detect();
  await h.svc.start();
  h.answers.value = true;
  await waitFor(() => h.svc.getStatus().state === 'running');
  h.answers.value = false;
  h.child.emit('exit', 137);
  await waitFor(() => h.svc.getStatus().state === 'failed');

  // second life: restart from failed, then exit cleanly
  const h2 = makeService();
  await h2.svc.detect();
  await h2.svc.start();
  h2.answers.value = true;
  await waitFor(() => h2.svc.getStatus().state === 'running');
  h2.child.emit('exit', 0);
  await waitFor(() => h2.svc.getStatus().state === 'stopped');
});

test('readiness budget exhausted -> failed and the child is killed', async () => {
  const h = makeService();
  await h.svc.detect();
  await h.svc.start();
  // probe stays false; FAST budget is 200ms
  await waitFor(() => h.svc.getStatus().state === 'failed', 2000);
  assert.ok(h.child.kills.length >= 1, 'the never-ready child must be killed');
  assert.match(h.svc.getStatus().error, /did not answer \/livez/);
});

test('readiness budget expiry on a kill-resistant child escalates to taskkill (no starting wedge)', async () => {
  const child = makeChild({ pid: 8888, exitOnKill: false });
  const h = makeService({ child });
  await h.svc.detect();
  await h.svc.start();
  // probe stays false; budget expires, soft kill is ignored, the grace escalation must fire
  await waitFor(() => h.exec.calls.taskkill.length === 1, 2000);
  assert.deepEqual(h.exec.calls.taskkill[0], ['/PID', '8888', '/T', '/F']);
  child.emit('exit', 1); // tree-kill lands
  await waitFor(() => h.svc.getStatus().state === 'failed');
  assert.match(h.svc.getStatus().error, /did not answer \/livez/);
});

test('stop kills the child; cooperative exit avoids taskkill', async () => {
  const h = makeService();
  await h.svc.detect();
  await h.svc.start();
  h.answers.value = true;
  await waitFor(() => h.svc.getStatus().state === 'running');
  const r = h.svc.stop();
  assert.equal(r.ok, true);
  await waitFor(() => h.svc.getStatus().state === 'stopped');
  // wait past the kill grace to prove the fallback was cancelled
  await new Promise((res) => setTimeout(res, FAST.killGraceMs * 3));
  assert.equal(h.exec.calls.taskkill.length, 0, 'cooperative exit must not trigger taskkill');
});

test('stubborn child (ignores kill) escalates to taskkill /PID <pid> /T /F', async () => {
  const child = makeChild({ pid: 7777, exitOnKill: false });
  const h = makeService({ child });
  await h.svc.detect();
  await h.svc.start();
  h.answers.value = true;
  await waitFor(() => h.svc.getStatus().state === 'running');
  h.svc.stop();
  await waitFor(() => h.exec.calls.taskkill.length === 1, 2000);
  assert.deepEqual(h.exec.calls.taskkill[0], ['/PID', '7777', '/T', '/F']);
  child.emit('exit', 1); // tree-kill lands
  await waitFor(() => h.svc.getStatus().state === 'stopped');
});

test('stop from running-external is refused and signals nothing', async () => {
  const h = makeService();
  await h.svc.detect();
  h.answers.value = true;
  await h.svc.start();
  assert.equal(h.svc.getStatus().state, 'running-external');
  const r = h.svc.stop();
  assert.equal(r.ok, false);
  assert.match(r.error, /external/);
  assert.equal(h.child.kills.length, 0);
  assert.equal(h.exec.calls.taskkill.length, 0);
});

test('dispose mid-starting clears the readiness poll and kills the owned child', async () => {
  const h = makeService();
  await h.svc.detect();
  await h.svc.start();
  assert.equal(h.svc.getStatus().state, 'starting');
  h.svc.dispose();
  assert.ok(h.child.kills.length >= 1, 'dispose must kill the owned child');
  const probesAtDispose = h.probeCalls.length;
  await new Promise((res) => setTimeout(res, FAST.readyPollMs * 6));
  assert.equal(h.probeCalls.length, probesAtDispose, 'poll must not keep probing after dispose');
});

test('dispose never touches an external proxy', async () => {
  const h = makeService();
  await h.svc.detect();
  h.answers.value = true;
  await h.svc.start();
  assert.equal(h.svc.getStatus().state, 'running-external');
  h.svc.dispose();
  assert.equal(h.child.kills.length, 0);
  assert.equal(h.exec.calls.taskkill.length, 0);
});

test('event contract: only status events are ever emitted, even through a failure', async () => {
  const h = makeService();
  await h.svc.detect();
  await h.svc.start();
  h.child.stderr.emit('data', 'boom\n');
  h.child.emit('exit', 1);
  await waitFor(() => h.svc.getStatus().state === 'failed');
  assert.ok(h.events.length > 0);
  assert.ok(h.events.every((name) => name === 'status'), `unexpected events: ${h.events}`);
});

test('invalid configured port falls back to the default in the spawn argv', async () => {
  const h = makeService({ port: 99999 });
  await h.svc.detect();
  await h.svc.start();
  assert.deepEqual(h.spawned[0].args.slice(-3), ['proxy', '--port', '8787']);
});
