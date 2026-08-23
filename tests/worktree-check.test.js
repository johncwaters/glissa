'use strict';

// The advisory post-rebase check (2026-08 review, section 4). A merge queue runs the project's tests
// against the candidate as it would land and merges on green; Glissa's merge click is the operator's,
// so this is the advisory half: the answer is on the card BEFORE that click, and it gates nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createWorktreeCheck } = require('../server/worktree-check');
const {
  decidePostRebaseCheck, resolveCheckCommand, summarizeCheckResult,
} = require('../session/core/check-gate');
const { checkChipText, checkDetailText, checkTone } = require('../public/check-status-core.mjs');

// A child_process stand-in: streams plus the close/error events the shell listens for.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

// --- which command runs ---

test('a per-project command beats the global one, which beats the npm fallback', () => {
  assert.deepEqual(
    resolveCheckCommand({ projectCheckCommand: 'cargo test', configCheckCommand: 'make check', packageJson: { scripts: { test: 'vitest' } } }),
    { command: 'cargo test', source: 'project' }
  );
  assert.deepEqual(
    resolveCheckCommand({ configCheckCommand: 'make check', packageJson: { scripts: { test: 'vitest' } } }),
    { command: 'make check', source: 'config' }
  );
  assert.deepEqual(
    resolveCheckCommand({ packageJson: { scripts: { test: 'vitest' } } }),
    { command: 'npm test', source: 'package-json' }
  );
});

// A repo with no tests must run nothing, rather than failing every check on "missing script: test".
test('a project with no configured command and no test script resolves nothing', () => {
  assert.deepEqual(resolveCheckCommand({}), { command: null, source: 'none' });
  assert.deepEqual(resolveCheckCommand({ packageJson: { scripts: {} } }), { command: null, source: 'none' });
  assert.deepEqual(resolveCheckCommand({ projectCheckCommand: '   ' }), { command: null, source: 'none' });
});

test('the gate refuses without a command, while disabled, or during teardown', () => {
  assert.deepEqual(decidePostRebaseCheck({ enabled: true, command: 'npm test' }), { run: true, reason: 'rebased' });
  assert.deepEqual(decidePostRebaseCheck({ enabled: false, command: 'npm test' }), { run: false, reason: 'disabled' });
  assert.deepEqual(decidePostRebaseCheck({ enabled: true, command: null }), { run: false, reason: 'no-command' });
  assert.deepEqual(decidePostRebaseCheck({ enabled: true, command: 'npm test', destroyed: true }), { run: false, reason: 'teardown' });
  assert.deepEqual(decidePostRebaseCheck({ enabled: true, command: 'npm test', teardownPending: true }), { run: false, reason: 'teardown' });
});

// Advisory means every outcome is reportable: there is no "did not run" that reads as a failure.
test('every outcome summarizes to a verdict, never to a throw', () => {
  assert.deepEqual(summarizeCheckResult({ exitCode: 0, output: 'ok' }), { status: 'pass', exitCode: 0, tail: 'ok' });
  assert.deepEqual(summarizeCheckResult({ exitCode: 1, output: 'boom' }), { status: 'fail', exitCode: 1, tail: 'boom' });
  assert.equal(summarizeCheckResult({ timedOut: true, exitCode: null }).status, 'timeout');
  assert.equal(summarizeCheckResult({ error: new Error('ENOENT') }).status, 'error');
  assert.equal(summarizeCheckResult({ exitCode: null }).status, 'fail', 'a signal-killed run is not a pass');
});

// --- the shell ---

test('a passing command reports pass with its tail', async () => {
  const child = fakeChild();
  const check = createWorktreeCheck({ spawnFn: () => child, now: (() => { let t = 0; return () => { t += 1000; return t; }; })() });
  const running = check.run({ cwd: '/w', command: 'npm test' });
  child.stdout.emit('data', 'all good');
  child.emit('close', 0);
  const result = await running;
  assert.equal(result.status, 'pass');
  assert.equal(result.command, 'npm test');
  assert.equal(result.tail, 'all good');
  assert.equal(result.durationMs, 1000);
});

test('a failing command reports its exit code and stderr', async () => {
  const child = fakeChild();
  const check = createWorktreeCheck({ spawnFn: () => child });
  const running = check.run({ cwd: '/w', command: 'npm test' });
  child.stderr.emit('data', '2 failing');
  child.emit('close', 1);
  const result = await running;
  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
  assert.equal(result.tail, '2 failing');
});

// A check that hangs (a dev server started by a test script, a prompt nobody answers) must cost a
// verdict, never a wedged worktree.
test('an overrunning command is killed and reported as a timeout', async () => {
  const child = fakeChild();
  const check = createWorktreeCheck({ spawnFn: () => child, timeoutMs: 20 });
  const running = check.run({ cwd: '/w', command: 'npm test' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(child.killed, true);
  child.emit('close', null);
  assert.equal((await running).status, 'timeout');
});

test('a spawn that throws is an error verdict, not a rejection', async () => {
  const check = createWorktreeCheck({ spawnFn: () => { throw new Error('no shell'); } });
  const result = await check.run({ cwd: '/w', command: 'npm test' });
  assert.equal(result.status, 'error');
  assert.match(result.tail, /no shell/);
});

test('the output tail is capped so a chatty runner cannot fill a tooltip', async () => {
  const child = fakeChild();
  const check = createWorktreeCheck({ spawnFn: () => child });
  const running = check.run({ cwd: '/w', command: 'npm test' });
  child.stdout.emit('data', 'x'.repeat(50_000));
  child.emit('close', 1);
  const result = await running;
  assert.equal(result.tail.length, 2000);
});

// ASYNC, and read that way on purpose: resolve() runs on the watcher-driven rebase path, and all
// sessions share one event loop (AGENTS.md, no sync fs on recurring paths).
test('resolve reads the worktree package.json without running anything', async () => {
  let spawned = 0;
  const check = createWorktreeCheck({
    spawnFn: () => { spawned += 1; return fakeChild(); },
    readFile: async () => JSON.stringify({ scripts: { test: 'node --test' } }),
  });
  assert.deepEqual(await check.resolve({ cwd: '/w' }), { command: 'npm test', source: 'package-json' });
  assert.equal(spawned, 0);
});

test('an unreadable package.json resolves to nothing rather than throwing', async () => {
  const check = createWorktreeCheck({ readFile: async () => { throw new Error('ENOENT'); } });
  assert.deepEqual(await check.resolve({ cwd: '/w' }), { command: null, source: 'none' });
});

// The two command sources stay separate all the way down, so `source` names the one that supplied it.
test('resolve reports which source the command actually came from', async () => {
  const check = createWorktreeCheck({ readFile: async () => JSON.stringify({ scripts: { test: 'vitest' } }) });
  assert.deepEqual(
    await check.resolve({ cwd: '/w', projectCheckCommand: 'cargo test', configCheckCommand: 'make check' }),
    { command: 'cargo test', source: 'project' }
  );
  assert.deepEqual(
    await check.resolve({ cwd: '/w', configCheckCommand: 'make check' }),
    { command: 'make check', source: 'config' }
  );
  assert.deepEqual(await check.resolve({ cwd: '/w' }), { command: 'npm test', source: 'package-json' });
});

// --- what the operator reads ---

test('the chip says green or red, and the detail says it decides nothing', () => {
  assert.equal(checkChipText({ status: 'pass' }), 'check green');
  assert.equal(checkChipText({ status: 'fail' }), 'check red');
  assert.equal(checkChipText({ status: 'running' }), 'checking');
  assert.equal(checkChipText(null), null, 'a session with no check has no chip');
  assert.equal(checkTone({ status: 'pass' }), 'good');
  assert.equal(checkTone({ status: 'timeout' }), 'bad');
  assert.equal(checkTone({ status: 'running' }), 'busy');
  assert.equal(checkTone(null), null);

  const detail = checkDetailText({ status: 'fail', command: 'npm test', exitCode: 1, durationMs: 42_000, tail: '2 failing' });
  assert.match(detail, /npm test/);
  assert.match(detail, /took 42s/);
  assert.match(detail, /exit 1/);
  assert.match(detail, /advisory only, it does not block the merge/);
  assert.match(detail, /2 failing/);
});

// A shell-spawned check on Windows is cmd.exe with npm.cmd, node and the test runner UNDER it.
// child.kill() signals only cmd, and the tree survives holding open handles inside the worktree: the
// timeout then reports a verdict while the run keeps writing there, and the next auto-rebase fails on
// those handles. Same taskkill /T /F reap the PTY path uses.
test('a win32 timeout reaps the whole process tree, not just the shell', async () => {
  const child = fakeChild();
  child.pid = 4321;
  const killed = [];
  const check = createWorktreeCheck({
    spawnFn: () => child,
    timeoutMs: 20,
    platform: 'win32',
    killTree: (args, _opts, cb) => { killed.push(args); cb(null); },
  });
  const running = check.run({ cwd: '/w', command: 'npm test' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(killed, [['/PID', '4321', '/T', '/F']]);
  assert.equal(child.killed, false, 'the shell is not signalled separately; the tree kill covers it');
  child.emit('close', null);
  assert.equal((await running).status, 'timeout');
});

// The same failure off Windows: child.kill() SIGTERMs /bin/sh alone while npm and the test runner keep
// running inside the worktree. The child is spawned detached, so it leads its own process group and one
// signal to the negative pid reaches all of it.
test('off win32 the timeout kills the process group, not just the shell', async () => {
  const child = fakeChild();
  child.pid = 99;
  const killed = [];
  const groupSignals = [];
  const check = createWorktreeCheck({
    spawnFn: () => child,
    timeoutMs: 20,
    platform: 'linux',
    killTree: (args, _opts, cb) => { killed.push(args); cb(null); },
    killGroup: (pid, signal) => groupSignals.push([pid, signal]),
  });
  const running = check.run({ cwd: '/w', command: 'npm test' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(groupSignals, [[-99, 'SIGKILL']]);
  assert.equal(child.killed, false, 'the shell is not signalled separately; the group kill covers it');
  assert.deepEqual(killed, [], 'taskkill is a Windows tool');
  child.emit('close', null);
  assert.equal((await running).status, 'timeout');
});

// A group signal to a group that already died is the ordinary outcome, and must not throw out of the
// timer callback (which is nobody's catch).
test('an already-dead group off win32 is swallowed, and the verdict still lands', async () => {
  const child = fakeChild();
  child.pid = 99;
  const check = createWorktreeCheck({
    spawnFn: () => child,
    timeoutMs: 20,
    platform: 'linux',
    killGroup: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); },
  });
  const running = check.run({ cwd: '/w', command: 'npm test' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  child.emit('close', null);
  assert.equal((await running).status, 'timeout');
});

// detached is what makes the group kill above possible; on Windows it would open a console window and
// taskkill /T needs nothing from us.
test('the child is spawned detached off win32 and never on it', async () => {
  const seen = [];
  const spawnFn = (_command, options) => { seen.push(options); return fakeChild(); };
  createWorktreeCheck({ spawnFn, platform: 'linux' }).run({ cwd: '/w', command: 'npm test' });
  createWorktreeCheck({ spawnFn, platform: 'win32' }).run({ cwd: '/w', command: 'npm test' });
  assert.equal(seen[0].detached, true);
  assert.equal(seen[0].shell, true);
  assert.equal(seen[1].detached, false);
});

// pid 0 negated is our OWN process group and pid 1 is every process this user can signal, so neither
// may reach the group kill; the child itself is still signalled.
test('a pid below 2 falls back to child.kill and never reaches the group kill', async () => {
  for (const pid of [0, 1]) {
    const child = fakeChild();
    child.pid = pid;
    const check = createWorktreeCheck({
      spawnFn: () => child,
      timeoutMs: 20,
      platform: 'linux',
      killGroup: () => assert.fail(`pid ${pid} must never be signalled as a group`),
    });
    const running = check.run({ cwd: '/w', command: 'npm test' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(child.killed, true);
    child.emit('close', null);
    assert.equal((await running).status, 'timeout');
  }
});

test('a child with no pid yet falls back to child.kill rather than reaping nothing', async () => {
  for (const platform of ['win32', 'linux']) {
    const child = fakeChild();
    child.pid = undefined;
    const check = createWorktreeCheck({
      spawnFn: () => child,
      timeoutMs: 20,
      platform,
      killTree: (_a, _o, cb) => cb(null),
      killGroup: () => assert.fail('a pid-less child has no group to signal'),
    });
    const running = check.run({ cwd: '/w', command: 'npm test' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(child.killed, true);
    child.emit('close', null);
    assert.equal((await running).status, 'timeout');
  }
});
