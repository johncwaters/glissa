'use strict';

// Spawn-time context-pack delivery: a built pack becomes an --add-dir plus the CLAUDE.md env flag and
// a snapshot version stamp, an unbuilt one is skipped into the decision trace, and a session with no
// packs spawns exactly as before. Uses the injected ptySpawn fake, so no real process is launched.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Session } = require('../session/sessions');
const { createSessionPackDelivery } = require('../session/session-pack-delivery');
const codex = require('../session/adapters/codex');
const { HookRouter } = require('../detection/hook-source');
const { PACK_READ_TOOL_MATCHER, WAKEUP_TOOL_MATCHER } = require('../detection/settings-injector');

const CLAUDE_MD_ENV = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';
// The absence assertions below read the spawn env, which inherits process.env; a stray ambient value
// would make them meaningless.
delete process.env[CLAUDE_MD_ENV];

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function fakePty(pid = 2147483646) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

function fixtureVersion(label) {
  return crypto.createHash('sha256').update(label).digest('hex');
}

function fixtureVersionDir(builtRoot, name, label) {
  return path.join(builtRoot, name, 'versions', fixtureVersion(label));
}

async function makeBuiltRoot(packs) {
  const builtRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-packs-'));
  for (const [name, value] of Object.entries(packs)) {
    const { version: versionLabel, ...extra } = typeof value === 'string' ? { version: value } : value;
    const version = fixtureVersion(versionLabel);
    const currentDir = path.join(builtRoot, name, 'current');
    const versionDir = path.join(builtRoot, name, 'versions', version);
    await fsp.mkdir(currentDir, { recursive: true });
    await fsp.mkdir(versionDir, { recursive: true });
    await fsp.writeFile(path.join(currentDir, 'version'), `${version}\n`, 'utf8');
    await fsp.writeFile(path.join(versionDir, 'CLAUDE.md'), `# ${name}\n`, 'utf8');
    await fsp.writeFile(
      path.join(versionDir, 'manifest.json'),
      JSON.stringify({ name, version, tokenEstimate: 10, ...extra }, null, 2),
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
  const builtRoot = await makeBuiltRoot({ 'house-rules': 'v-abc' });
  const calls = [];
  const s = new Session({
    id: 'packed',
    name: 'packed',
    path: process.cwd(),
    packs: ['house-rules'],
    packsBuiltRoot: builtRoot,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    await s.start();
    const packDir = fixtureVersionDir(builtRoot, 'house-rules', 'v-abc');
    assert.deepEqual(calls[0].args, ['--add-dir', packDir]);
    assert.equal(calls[0].opts.env[CLAUDE_MD_ENV], '1');
    assert.deepEqual(s.toSnapshot().packs, [{ name: 'house-rules', version: fixtureVersion('v-abc') }]);
    const delivered = s.getDebugState().decisions.filter((d) => d.kind === 'pack');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].decision, 'delivered');
    assert.equal(delivered[0].version, fixtureVersion('v-abc'));
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a measurable packed session injects Read tracking after pack resolution', async () => {
  const builtRoot = await makeBuiltRoot({ 'house-rules': 'v-abc' });
  const hooksBaseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-pack-hooks-'));
  const payloads = [];
  const session = new Session({
    id: 'measured-pack',
    name: 'measured-pack',
    path: process.cwd(),
    packs: ['house-rules'],
    packsBuiltRoot: builtRoot,
    hookRouter: new HookRouter(),
    getHookPort: () => 4321,
    hooksBaseDir,
    millMetricsPort: { onHookEvent: () => {} },
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
  });
  session.on('packs-delivered', (payload) => payloads.push(payload));
  try {
    await session.start();
    const settings = JSON.parse(await fsp.readFile(path.join(hooksBaseDir, 'measured-pack', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.hooks.PostToolUse.map((entry) => entry.matcher), [
      WAKEUP_TOOL_MATCHER,
      PACK_READ_TOOL_MATCHER,
    ]);
    assert.equal(payloads[0].readDetection, 'available');
    assert.equal(payloads[0].packs[0].dir, fixtureVersionDir(builtRoot, 'house-rules', 'v-abc'));
    assert.equal(payloads[0].packs[0].tokenEstimate, 10);
  } finally {
    session.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
  }
});

test('a delivery whose Read matcher never reached the settings file is reported unmeasurable', async () => {
  const builtRoot = await makeBuiltRoot({ 'house-rules': 'v-abc' });
  const payloads = [];
  const session = new Session({
    id: 'unhooked-pack',
    name: 'unhooked-pack',
    path: process.cwd(),
    packs: ['house-rules'],
    packsBuiltRoot: builtRoot,
    millMetricsPort: { onHookEvent: () => {} },
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
  });
  session.on('packs-delivered', (payload) => payloads.push(payload));
  try {
    await session.start();
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].readDetection, 'unavailable');
  } finally {
    session.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a spawn that never starts delivers no measurable pack', async () => {
  const builtRoot = await makeBuiltRoot({ 'house-rules': 'v-abc' });
  const payloads = [];
  const session = new Session({
    id: 'unspawned-pack',
    name: 'unspawned-pack',
    path: process.cwd(),
    packs: ['house-rules'],
    packsBuiltRoot: builtRoot,
    millMetricsPort: { onHookEvent: () => {} },
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => { throw new Error('spawn refused'); },
  });
  session.on('error', () => {});
  session.on('packs-delivered', (payload) => payloads.push(payload));
  try {
    await session.start();
    assert.deepEqual(payloads, []);
  } finally {
    session.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('measurement leaves a session without delivered packs on the existing matcher set', async () => {
  const hooksBaseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-pack-hooks-'));
  const session = new Session({
    id: 'measured-empty',
    name: 'measured-empty',
    path: process.cwd(),
    hookRouter: new HookRouter(),
    getHookPort: () => 4321,
    hooksBaseDir,
    millMetricsPort: { onHookEvent: () => {} },
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
  });
  try {
    await session.start();
    const settings = JSON.parse(await fsp.readFile(path.join(hooksBaseDir, 'measured-empty', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.hooks.PostToolUse.map((entry) => entry.matcher), [WAKEUP_TOOL_MATCHER]);
  } finally {
    session.destroy();
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
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
      '--add-dir', fixtureVersionDir(builtRoot, 'beta', 'v2'),
      '--add-dir', fixtureVersionDir(builtRoot, 'alpha', 'v1'),
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
  const version = fixtureVersion('half-built');
  await fsp.mkdir(path.join(builtRoot, 'half-built', 'current'), { recursive: true });
  await fsp.mkdir(path.join(builtRoot, 'half-built', 'versions', version), { recursive: true });
  await fsp.writeFile(path.join(builtRoot, 'half-built', 'current', 'version'), `${version}\n`, 'utf8');
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
      '--add-dir', fixtureVersionDir(builtRoot, 'alpha', 'v1'),
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
    assert.deepEqual(calls[0].args, ['--add-dir', fixtureVersionDir(builtRoot, 'alpha', 'v1')]);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('packs: "house-rules" (not an array) is ignored entirely', async () => {
  const calls = [];
  const s = new Session({
    id: 'not-an-array',
    name: 'not-an-array',
    path: process.cwd(),
    packs: 'house-rules',
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

// ---- Per-project variants: this project's flattened pack, with the group as the fallback ----

const SLUG = 'glissa-12345678';

async function startWithPacks(builtRoot, options = {}) {
  const calls = [];
  const s = new Session({
    id: 'variant',
    name: 'variant',
    path: process.cwd(),
    packs: ['memory'],
    packsBuiltRoot: builtRoot,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
    ...options,
  });
  await s.start();
  return { s, calls, decisions: s.getDebugState().decisions.filter((d) => d.kind === 'pack') };
}

test('a project delivers ITS variant of a group pack, and the snapshot records the resolved name', async () => {
  const builtRoot = await makeBuiltRoot({
    memory: { version: 'v-base', perProjectVariants: true },
    [`memory-${SLUG}`]: { version: 'v-mine', group: 'memory', projectId: 'p1', projectSlug: SLUG },
  });
  const { s, calls, decisions } = await startWithPacks(builtRoot, { packVariantSlug: SLUG });
  try {
    assert.deepEqual(calls[0].args, ['--add-dir', fixtureVersionDir(builtRoot, `memory-${SLUG}`, 'v-mine')]);
    assert.deepEqual(s.toSnapshot().packs, [{ name: `memory-${SLUG}`, version: fixtureVersion('v-mine') }]);
    assert.deepEqual(decisions.map((d) => d.decision), ['delivered']);
    assert.equal(decisions[0].name, `memory-${SLUG}`);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a project with no variant built yet falls back to the base pack, and says so in the trace', async () => {
  const builtRoot = await makeBuiltRoot({ memory: { version: 'v-base', perProjectVariants: true } });
  const { s, calls, decisions } = await startWithPacks(builtRoot, { packVariantSlug: SLUG });
  try {
    assert.deepEqual(calls[0].args, ['--add-dir', fixtureVersionDir(builtRoot, 'memory', 'v-base')]);
    assert.deepEqual(s.toSnapshot().packs, [{ name: 'memory', version: fixtureVersion('v-base') }]);
    assert.deepEqual(decisions.map((d) => d.decision), ['variant-fallback', 'delivered']);
    assert.equal(decisions[0].name, 'memory');
    assert.match(decisions[0].reason, /not built/);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a lane session, which has no project slug, is delivered the base pack with no fallback entry', async () => {
  const builtRoot = await makeBuiltRoot({
    memory: { version: 'v-base', perProjectVariants: true },
    [`memory-${SLUG}`]: { version: 'v-mine', group: 'memory' },
  });
  const { s, calls, decisions } = await startWithPacks(builtRoot);
  try {
    assert.deepEqual(calls[0].args, ['--add-dir', fixtureVersionDir(builtRoot, 'memory', 'v-base')]);
    assert.deepEqual(decisions.map((d) => d.decision), ['delivered']);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a plain pack is never probed for a variant, whatever slug the project carries', async () => {
  const builtRoot = await makeBuiltRoot({ memory: 'v-plain' });
  const { s, calls, decisions } = await startWithPacks(builtRoot, { packVariantSlug: SLUG });
  try {
    assert.deepEqual(calls[0].args, ['--add-dir', fixtureVersionDir(builtRoot, 'memory', 'v-plain')]);
    assert.deepEqual(decisions.map((d) => d.decision), ['delivered']);
    assert.deepEqual(s.toSnapshot().packs, [{ name: 'memory', version: fixtureVersion('v-plain') }]);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a codex session carries the resolved variant by index pointer without Claude pack flags', async () => {
  const builtRoot = await makeBuiltRoot({
    memory: { version: 'v-base', perProjectVariants: true },
    [`memory-${SLUG}`]: { version: 'v-mine', group: 'memory', projectId: 'p1', projectSlug: SLUG },
  });
  const { s, calls, decisions } = await startWithPacks(builtRoot, { agent: 'codex', packVariantSlug: SLUG });
  try {
    const packDir = fixtureVersionDir(builtRoot, `memory-${SLUG}`, 'v-mine');
    const carrierArgs = codex.renderPackArgs([{ name: `memory-${SLUG}`, dir: packDir }]);
    assert.deepEqual(calls[0].args, [...carrierArgs, '-c', 'check_for_update_on_startup=false']);
    assert.equal(calls[0].args.includes('--add-dir'), false);
    assert.equal(CLAUDE_MD_ENV in calls[0].opts.env, false);
    assert.deepEqual(s.toSnapshot().packs, [{ name: `memory-${SLUG}`, version: fixtureVersion('v-mine') }]);
    assert.deepEqual(s.toSnapshot().packs[0], { name: `memory-${SLUG}`, version: fixtureVersion('v-mine') });
    assert.deepEqual(decisions.map((decision) => decision.decision), ['delivered']);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a missing codex pack is skipped without a carrier token or Claude env flag', async () => {
  const builtRoot = await makeBuiltRoot({});
  const { s, calls, decisions } = await startWithPacks(builtRoot, { agent: 'codex' });
  try {
    assert.deepEqual(calls[0].args, ['-c', 'check_for_update_on_startup=false']);
    assert.equal(CLAUDE_MD_ENV in calls[0].opts.env, false);
    assert.deepEqual(s.toSnapshot().packs, []);
    assert.deepEqual(decisions.map((decision) => decision.decision), ['skipped']);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a pack update between lookups still arms a notice before the delivered list swaps', async () => {
  const previousDeliveries = [
    { name: 'alpha', version: 'v1', dir: '/packs/alpha/current' },
    { name: 'beta', version: 'v1', dir: '/packs/beta/current' },
  ];
  const packDelivery = createSessionPackDelivery({
    configuredPacks: ['alpha', 'beta'],
    builtRoot: '/packs',
    variantSlug: null,
    projectPath: process.cwd(),
    sessionName: 'atomic-packs',
    agentId: 'codex',
    canDeliver: () => true,
    canNotify: () => true,
    renderArgs: () => [],
    recordDecision: () => {},
    resolvePack: async (name) => {
      assert.deepEqual(packDelivery.delivered(), previousDeliveries.map(({ name: packName, version }) => ({ name: packName, version })));
      if (name === 'beta') assert.equal(packDelivery.noteUpdate('alpha', 'v2'), true);
      return { name, version: 'v1', dir: `/packs/${name}/current` };
    },
  });
  packDelivery.replaceDelivered(previousDeliveries);
  assert.deepEqual(packDelivery.deliveredWithDirs(), previousDeliveries.map((pack) => ({
    ...pack,
    tokenEstimate: null,
  })));
  assert.deepEqual(packDelivery.delivered(), [
    { name: 'alpha', version: 'v1' },
    { name: 'beta', version: 'v1' },
  ]);
  const delivery = await packDelivery.resolve();
  assert.deepEqual(delivery.packs.map((pack) => pack.name), ['alpha', 'beta']);
  assert.match(packDelivery.takeNotice(), /"alpha" \(version v1 is now v2\)/);
});

test('a pack built out of the project\'s own files is skipped as self-referential', async () => {
  const builtRoot = await makeBuiltRoot({ mirror: { version: 'v1', sourceRoots: [`${toPosix(process.cwd())}/docs`], sources: [{ pattern: 'docs/*.md', files: [{ relPath: 'a.md' }] }] } });
  const calls = [];
  const s = new Session({
    id: 'mirror', name: 'mirror', path: process.cwd(),
    packs: ['mirror'], packsBuiltRoot: builtRoot,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    await s.start();
    assert.deepEqual(calls[0].args, []);
    assert.equal(CLAUDE_MD_ENV in calls[0].opts.env, false);
    assert.deepEqual(s.toSnapshot().packs, []);
    const skips = s.getDebugState().decisions.filter((d) => d.kind === 'pack');
    assert.deepEqual(skips.map((d) => [d.decision, d.reason]), [['skipped', 'self-referential']]);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('the same pack still reaches a project it was not built out of', async () => {
  const builtRoot = await makeBuiltRoot({ mirror: { version: 'v1', sourceRoots: [`${toPosix(process.cwd())}/docs`], sources: [{ pattern: 'docs/*.md', files: [{ relPath: 'a.md' }] }] } });
  const calls = [];
  const s = new Session({
    id: 'elsewhere', name: 'elsewhere', path: os.tmpdir(),
    packs: ['mirror'], packsBuiltRoot: builtRoot,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    await s.start();
    assert.deepEqual(calls[0].args, ['--add-dir', fixtureVersionDir(builtRoot, 'mirror', 'v1')]);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a build carrying only its own index is skipped as empty, costing the session nothing', async () => {
  const builtRoot = await makeBuiltRoot({ hollow: { version: 'v1', sources: [], rules: [], skills: [] } });
  const calls = [];
  const s = new Session({
    id: 'hollow', name: 'hollow', path: process.cwd(),
    packs: ['hollow'], packsBuiltRoot: builtRoot,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: spawnCapture(calls),
  });
  try {
    await s.start();
    assert.deepEqual(calls[0].args, []);
    assert.equal(CLAUDE_MD_ENV in calls[0].opts.env, false);
    assert.deepEqual(s.toSnapshot().packs, []);
    const skips = s.getDebugState().decisions.filter((d) => d.kind === 'pack');
    assert.deepEqual(skips.map((d) => [d.decision, d.reason]), [['skipped', 'empty']]);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});
