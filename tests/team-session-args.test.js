'use strict';

// Verifies the team-stage Session options (initialPrompt / extraClaudeArgs / ephemeral) wire into
// start()'s claudeArgs in the right ORDER, using the injected ptySpawn fake so no real process is
// launched (a real spawn would keep the PTY alive and hang the runner — see docs/progress.txt learning).

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../sessions');

function fakePty(pid = 2147483646) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
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
