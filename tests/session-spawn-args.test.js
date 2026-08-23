'use strict';

// Verifies the team-stage Session options (initialPrompt / extraClaudeArgs / ephemeral) wire into
// start()'s claudeArgs in the right ORDER, using the injected ptySpawn fake so no real process is
// launched (a real spawn would keep the PTY alive and hang the runner, see docs/progress.txt learning).

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../session/sessions');
const { STATES } = require('../shared/states');

function fakePty(pid = 2147483646) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

// Bounded wait on an observable fact (the respawn landing), the shape backend-auto-resume.test.js uses.
// Counting turns instead read the FIRST spawn's args on Linux, where start()'s prior-PTY reap takes a
// different number of turns than the win32 taskkill it was tuned to; the resume assertion below then
// passed for the wrong reason, since the stale first spawn also carried --resume.
async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'condition became true');
}

test('start() appends extraClaudeArgs then the initialPrompt as the final positional arg', async () => {
  const calls = [];
  const s = new Session({
    id: 'team:run1:writer',
    name: 'writer',
    path: process.cwd(),
    dangerouslySkipPermissions: true,
    extraClaudeArgs: ['-p', '--model', 'sonnet'],
    initialPrompt: 'STAGE PROMPT TEXT\nwith a newline',
    ephemeral: true,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
  });
  try {
    await s.start();
    assert.equal(calls.length, 1, 'spawned once');
    // No hookRouter injected -> no --settings; so args are exactly skipPerms + extra + prompt.
    assert.deepEqual(calls[0].args, [
      '--dangerously-skip-permissions',
      '-p',
      '--model',
      'sonnet',
      'STAGE PROMPT TEXT\nwith a newline',
    ]);
    // The prompt is a single argv element (never word-split).
    assert.equal(calls[0].args[calls[0].args.length - 1], 'STAGE PROMPT TEXT\nwith a newline');
    assert.equal(s.toSnapshot().ephemeral, true);
  } finally {
    s.destroy();
  }
});

test('a session with no team options spawns exactly as before (no extra args)', async () => {
  const calls = [];
  const s = new Session({
    id: 'plain',
    name: 'plain',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
  });
  try {
    await s.start();
    assert.deepEqual(calls[0].args, [], 'no settings, no perms, no team args');
    assert.equal(s.toSnapshot().ephemeral, false);
  } finally {
    s.destroy();
  }
});

test('normal restart keeps the captured resume id in spawn args', async () => {
  const calls = [];
  const resumeSessionId = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';
  const s = new Session({
    id: 'resume-restart',
    name: 'resume-restart',
    path: process.cwd(),
    resumeSessionId,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
    killProc: (_args, _opts, cb) => cb(null, '', ''),
  });
  try {
    await s.start();
    s.state = STATES.DONE;

    assert.equal(s.restart(), true, 'restart accepted');
    await waitFor(() => calls.length === 2);

    const args = calls.at(-1).args;
    const resumeIndex = args.indexOf('--resume');
    assert.notEqual(resumeIndex, -1, 'restart spawned with --resume');
    assert.equal(args[resumeIndex + 1], resumeSessionId);
  } finally {
    s.destroy();
  }
});

test('fresh restart clears the resume id and spawns without --resume', async () => {
  const calls = [];
  const cleared = [];
  const s = new Session({
    id: 'fresh-restart',
    name: 'fresh-restart',
    path: process.cwd(),
    resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5',
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
    killProc: (_args, _opts, cb) => cb(null, '', ''),
  });
  s.on('resume-cleared', (payload) => cleared.push(payload));
  try {
    await s.start();
    s.state = STATES.DONE;

    assert.equal(s.restart({ fresh: true }), true, 'fresh restart accepted');
    await waitFor(() => calls.length === 2);

    assert.equal(s.resumeSessionId, null, 'live resume id cleared');
    assert.deepEqual(cleared, [{ id: 'fresh-restart' }]);
    assert.equal(calls.at(-1).args.includes('--resume'), false, 'fresh restart spawned without --resume');
  } finally {
    s.destroy();
  }
});
