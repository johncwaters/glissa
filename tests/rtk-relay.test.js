'use strict';

// The rtk relay's contract, driven through main() with a fake stdin, stdout and rtk runner: never
// throw, never block a tool call, and emit nothing at all rather than a verdict the calling CLI would
// reject. runRtk is exercised against a real child process so the stdin handoff and the non-zero-exit
// path are pinned rather than assumed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { main, runRtk } = require('../session/rtk-relay');
const { RTK_PATH_ENV } = require('../session/core/rtk-hook-core');

const ENVELOPE = '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git log"}}';
const REWRITE = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecisionReason: 'RTK auto-rewrite',
    updatedInput: { command: 'rtk git log' },
  },
});

function fakeStdin(text) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

function fakeStdout() {
  const written = [];
  return { written, write: (chunk) => { written.push(String(chunk)); return true; } };
}

function fakeRtk(stdoutText, seen = []) {
  return (rtkPath, body) => {
    seen.push({ rtkPath, body: body.toString('utf8') });
    return Promise.resolve(stdoutText);
  };
}

test('a rewrite is completed with permissionDecision and written as one line', async () => {
  const stdout = fakeStdout();
  const seen = [];
  const result = await main(
    { [RTK_PATH_ENV]: '/home/carbon/.local/bin/rtk' },
    fakeStdin(ENVELOPE),
    stdout,
    fakeRtk(REWRITE, seen),
  );
  assert.equal(result.code, 0);
  assert.deepEqual(seen, [{ rtkPath: '/home/carbon/.local/bin/rtk', body: ENVELOPE }]);
  assert.equal(stdout.written.length, 1);
  assert.equal(stdout.written[0].endsWith('\n'), true);
  assert.equal(JSON.parse(stdout.written[0]).hookSpecificOutput.permissionDecision, 'allow');
});

test('without the env target nothing is written and rtk is never run', async () => {
  const stdout = fakeStdout();
  const seen = [];
  const result = await main({}, fakeStdin(ENVELOPE), stdout, fakeRtk(REWRITE, seen));
  assert.equal(result.code, 0);
  assert.deepEqual(seen, []);
  assert.deepEqual(stdout.written, []);
});

test('an empty payload, an rtk failure and unusable output all emit nothing and exit 0', async () => {
  const cases = [
    ['', REWRITE],
    [ENVELOPE, ''],
    [ENVELOPE, 'rtk: command not found'],
  ];
  for (const [payload, rtkStdout] of cases) {
    const stdout = fakeStdout();
    const result = await main({ [RTK_PATH_ENV]: '/bin/rtk' }, fakeStdin(payload), stdout, fakeRtk(rtkStdout));
    assert.equal(result.code, 0);
    assert.deepEqual(stdout.written, [], `${payload}|${rtkStdout}`);
  }
});

test('runRtk resolves the empty verdict when the binary does not exist', async () => {
  const missing = path.join(os.tmpdir(), 'glissa-rtk-missing', 'rtk');
  assert.equal(await runRtk(missing, Buffer.from(ENVELOPE, 'utf8')), '');
});

// The real spawn path: stdin reaches the child, a clean exit keeps its stdout and a non-zero one
// discards it. POSIX-only because the stand-in has to be an executable image, and a Windows .cmd shim
// is exactly the re-parse this repo spawns around rather than through.
test('runRtk pipes the envelope to the child and keeps only a clean exit', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-rtk-relay-'));
  const writeExecutable = (name, script) => {
    const scriptPath = path.join(dir, `${name}.cjs`);
    fs.writeFileSync(scriptPath, script, 'utf8');
    const launcher = path.join(dir, name);
    fs.writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}\n`, 'utf8');
    fs.chmodSync(launcher, 0o755);
    return launcher;
  };
  try {
    const echoing = writeExecutable('echoing', 'process.stdin.on("data", (c) => process.stdout.write(c));\n');
    const failing = writeExecutable('failing', 'process.stdout.write("half"); process.exit(3);\n');
    assert.equal(await runRtk(echoing, Buffer.from(ENVELOPE, 'utf8')), ENVELOPE);
    assert.equal(await runRtk(failing, Buffer.from(ENVELOPE, 'utf8')), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
