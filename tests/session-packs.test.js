'use strict';

// Spawn-time context-pack delivery: a built pack becomes an --add-dir plus the CLAUDE.md env flag and
// a snapshot version stamp, an unbuilt one is skipped into the decision trace, and a session with no
// packs spawns exactly as before. Uses the injected ptySpawn fake, so no real process is launched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Session } = require('../session/sessions');

const CLAUDE_MD_ENV = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';
// The absence assertions below read the spawn env, which inherits process.env; a stray ambient value
// would make them meaningless.
delete process.env[CLAUDE_MD_ENV];

function fakePty(pid = 2147483646) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

async function makeBuiltRoot(packs) {
  const builtRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-packs-'));
  for (const [name, version] of Object.entries(packs)) {
    const currentDir = path.join(builtRoot, name, 'current');
    await fsp.mkdir(currentDir, { recursive: true });
    await fsp.writeFile(path.join(currentDir, 'CLAUDE.md'), `# ${name}\n`, 'utf8');
    await fsp.writeFile(
      path.join(currentDir, 'manifest.json'),
      JSON.stringify({ name, version, tokenEstimate: 10 }, null, 2),
      'utf8',
    );
  }
  return builtRoot;
}

function spawnCapture(calls) {
  return (file, args, opts) => {
    calls.push({ file, args, opts });
    return fakePty();
  };
}

test('a built pack spawns as --add-dir, sets the CLAUDE.md env flag, and rides the snapshot', async () => {
  const builtRoot = await makeBuiltRoot({ 'company-context': 'v-abc' });
  const calls = [];
  const s = new Session({
    id: 'packed',
    name: 'packed',
    path: process.cwd(),
    packs: ['company-context'],
    packsBuiltRoot: builtRoot,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    await s.start();
    const packDir = path.join(builtRoot, 'company-context', 'current');
    assert.deepEqual(calls[0].args, ['--add-dir', packDir]);
    assert.equal(calls[0].opts.env[CLAUDE_MD_ENV], '1');
    // `reads` rides every delivered entry from the start: 0 means "delivered and never opened",
    // which is exactly the measurable (see tests/session-pack-reads.test.js).
    assert.deepEqual(s.toSnapshot().packs, [{ name: 'company-context', version: 'v-abc', reads: 0 }]);
    const delivered = s.getDebugState().decisions.filter((d) => d.kind === 'pack');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].decision, 'delivered');
    assert.equal(delivered[0].version, 'v-abc');
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('several built packs deliver in configured order, one --add-dir pair each', async () => {
  const builtRoot = await makeBuiltRoot({ alpha: 'v1', beta: 'v2' });
  const calls = [];
  const s = new Session({
    id: 'two-packs',
    name: 'two-packs',
    path: process.cwd(),
    packs: ['beta', 'alpha'],
    packsBuiltRoot: builtRoot,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    await s.start();
    assert.deepEqual(calls[0].args, [
      '--add-dir', path.join(builtRoot, 'beta', 'current'),
      '--add-dir', path.join(builtRoot, 'alpha', 'current'),
    ]);
    assert.deepEqual(s.toSnapshot().packs.map((p) => p.name), ['beta', 'alpha']);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a configured but unbuilt pack is skipped: no --add-dir, no env flag, a recorded reason', async () => {
  const builtRoot = await makeBuiltRoot({});
  const calls = [];
  const s = new Session({
    id: 'unbuilt',
    name: 'unbuilt',
    path: process.cwd(),
    packs: ['never-built'],
    packsBuiltRoot: builtRoot,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    await s.start();
    assert.deepEqual(calls[0].args, [], 'an unresolvable pack must not reach argv');
    assert.equal(CLAUDE_MD_ENV in calls[0].opts.env, false, 'zero delivered packs means no env flag');
    assert.deepEqual(s.toSnapshot().packs, []);
    const skips = s.getDebugState().decisions.filter((d) => d.kind === 'pack');
    assert.equal(skips.length, 1);
    assert.equal(skips[0].decision, 'skipped');
    assert.match(skips[0].reason, /not built/);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a built dir with no manifest.json is skipped rather than guessed at', async () => {
  const builtRoot = await makeBuiltRoot({});
  await fsp.mkdir(path.join(builtRoot, 'half-built', 'current'), { recursive: true });
  const calls = [];
  const s = new Session({
    id: 'half-built',
    name: 'half-built',
    path: process.cwd(),
    packs: ['half-built'],
    packsBuiltRoot: builtRoot,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    await s.start();
    assert.deepEqual(calls[0].args, []);
    const skips = s.getDebugState().decisions.filter((d) => d.kind === 'pack');
    assert.match(skips[0].reason, /manifest\.json/);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('argv order: pack args sit ahead of the lane flags and the prompt stays the final positional', async () => {
  const builtRoot = await makeBuiltRoot({ alpha: 'v1' });
  const calls = [];
  const s = new Session({
    id: 'ordered',
    name: 'ordered',
    path: process.cwd(),
    dangerouslySkipPermissions: true,
    packs: ['alpha'],
    packsBuiltRoot: builtRoot,
    extraClaudeArgs: ['-p', '--model', 'sonnet'],
    initialPrompt: 'SEED PROMPT',
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    await s.start();
    assert.deepEqual(calls[0].args, [
      '--add-dir', path.join(builtRoot, 'alpha', 'current'),
      '--dangerously-skip-permissions',
      '-p', '--model', 'sonnet',
      'SEED PROMPT',
    ]);
    assert.equal(calls[0].args[calls[0].args.length - 1], 'SEED PROMPT');
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a session with no packs (every ephemeral lane session) spawns with the pre-pack argv and env', async () => {
  const calls = [];
  const s = new Session({
    id: 'no-packs',
    name: 'no-packs',
    path: process.cwd(),
    ephemeral: true,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    await s.start();
    assert.deepEqual(calls[0].args, []);
    assert.equal(CLAUDE_MD_ENV in calls[0].opts.env, false);
    assert.deepEqual(s.toSnapshot().packs, []);
    assert.deepEqual(s.getDebugState().decisions.filter((d) => d.kind === 'pack'), []);
  } finally {
    s.destroy();
  }
});

test('a malformed packs list costs the bad entries, not the spawn', async () => {
  const builtRoot = await makeBuiltRoot({ alpha: 'v1' });
  const calls = [];
  const s = new Session({
    id: 'malformed',
    name: 'malformed',
    path: process.cwd(),
    packs: ['alpha', 42, '../escape', 'alpha'],
    packsBuiltRoot: builtRoot,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    assert.deepEqual(s.packNames, ['alpha']);
    await s.start();
    assert.deepEqual(calls[0].args, ['--add-dir', path.join(builtRoot, 'alpha', 'current')]);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('packs: "company-context" (not an array) is ignored entirely', async () => {
  const calls = [];
  const s = new Session({
    id: 'not-an-array',
    name: 'not-an-array',
    path: process.cwd(),
    packs: 'company-context',
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    assert.deepEqual(s.packNames, []);
    await s.start();
    assert.deepEqual(calls[0].args, []);
  } finally {
    s.destroy();
  }
});
