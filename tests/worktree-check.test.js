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

test('resolve reads the worktree package.json without running anything', () => {
  let spawned = 0;
  const check = createWorktreeCheck({
    spawnFn: () => { spawned += 1; return fakeChild(); },
    readFile: () => JSON.stringify({ scripts: { test: 'node --test' } }),
  });
  assert.deepEqual(check.resolve({ cwd: '/w' }), { command: 'npm test', source: 'package-json' });
  assert.equal(spawned, 0);
});

test('an unreadable package.json resolves to nothing rather than throwing', () => {
  const check = createWorktreeCheck({ readFile: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(check.resolve({ cwd: '/w' }), { command: null, source: 'none' });
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
