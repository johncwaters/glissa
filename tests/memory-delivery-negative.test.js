'use strict';

// M16 of docs/plan-visions-3.md, "Enforced non-delivery", as relaxed to toggles-only: memory is a local
// store whose CONTENT reaches a session and nothing else, while its scalar knobs are dashboard settings
// like any other lane's. These are the negative pins: no memory-shaped control-WS message type exists at
// all, none is replayable, no lane logs remembered text, and the settings block accepts an allow-list of
// booleans and clamped integers, refusing a path or a content-shaped key BY NAME.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerControlHandlers } = require('../server/control-handlers');
const { createConfigStore, BOOLEAN_KEYS, STRING_KEYS, TIMEOUT_KEYS } = require('../server/config-store');
const { REPLAYABLE_EXACT, isReplayable } = require('../server/control-replay-core');
const { createMemoryStore } = require('../server/memory-store');
const { resolveMemoryConfig } = require('../server/core/memory-core');
const codex = require('../session/adapters/codex');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const REMEMBERED = 'the merge gate lives in session/core/merge-gate.js';

function harness(cfg, store) {
  const controlWss = new EventEmitter();
  const sent = [];
  let messageHandler = null;
  const ws = {
    glissaTrust: 'remote',
    send: (raw) => sent.push(JSON.parse(raw)),
    on: (event, handler) => { if (event === 'message') messageHandler = handler; },
  };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: store,
    applyConfigReload: () => {},
    applySettingsReload: (next) => store.applySettings(next),
    broadcastControl: () => {},
  });
  controlWss.emit('connection', ws);
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent };
}

function withRealStore(cfg, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-negative-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  const previous = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  try {
    const store = createConfigStore();
    return fn(harness(store.config, store), store);
  } finally {
    if (previous == null) delete process.env.GLISSA_CONFIG;
    if (previous != null) process.env.GLISSA_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LIVE_MEMORY = { enabled: true, distill: { enabled: false } };
// Every file-only key the Mill lanes accept from config.json: a path, a watched root, a shell list.
const FILE_ONLY = Object.freeze({
  memory: { ...LIVE_MEMORY, dbPath: '/tmp/glissa-memory.db' },
  ingest: {
    enabled: true,
    sources: { fs: { enabled: true, roots: ['/home/carbon/secrets'] }, shellHistory: { enabled: true, shells: ['zsh'] } },
  },
  packDistiller: { enabled: true, packsDir: '/home/carbon/.glissa/packs' },
});

test('no control-WS message type is memory-shaped, in any handler or broadcast', () => {
  const offenders = [];
  for (const name of fs.readdirSync(SERVER_DIR)) {
    if (!name.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(SERVER_DIR, name), 'utf8');
    for (const match of source.matchAll(/type:\s*'([a-z][a-z0-9-]*)'/g)) {
      if (!match[1].startsWith('memory')) continue;
      offenders.push(`${name}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('a remote-trust control socket is answered without a memory frame, and the echo is toggles only', () => {
  withRealStore({ projects: [], teams: [], memory: LIVE_MEMORY }, (driver, store) => {
    driver.send({ type: 'get-settings' });
    driver.send({ type: 'request-mill-report' });
    // The socket really was answered: an empty transcript would pass every assertion below for free.
    assert.equal(driver.sent.length > 0, true);
    const types = driver.sent.map((message) => message.type);
    assert.equal(types.some((type) => String(type).includes('memory')), false);
    const echoed = store.getSettings().memory;
    assert.deepEqual(echoed, LIVE_MEMORY);
    const { distill, ...scalars } = echoed;
    for (const value of [...Object.values(scalars), ...Object.values(distill)]) {
      assert.equal(typeof value === 'boolean' || typeof value === 'number', true);
    }
  });
});

// The way OUT is the same allow-list as the way in: a stored path is not echoable just because the
// operator put it in config.json themselves.
test('a file-only key of any Mill block is dropped from the settings echo', () => {
  withRealStore({ projects: [], teams: [], ...FILE_ONLY }, (driver, store) => {
    const settings = store.getSettings();
    assert.equal('dbPath' in settings.memory, false);
    assert.equal(settings.memory.enabled, true);
    assert.equal('roots' in settings.ingest.sources.fs, false);
    assert.equal('shells' in settings.ingest.sources.shellHistory, false);
    assert.equal(settings.ingest.sources.fs.enabled, true);
    assert.equal('packsDir' in settings.packDistiller, false);
    assert.equal(settings.packDistiller.enabled, true);
    driver.send({ type: 'get-settings' });
    const replied = driver.sent.find((message) => message.type === 'settings');
    assert.equal(JSON.stringify(replied).includes('/home/carbon/secrets'), false);
    assert.equal(JSON.stringify(replied).includes('glissa-memory.db'), false);
  });
});

test('memory is a block, never a scalar settings key, so no key list can carry a path into the config', () => {
  assert.equal(BOOLEAN_KEYS.includes('memory'), false);
  assert.equal(STRING_KEYS.includes('memory'), false);
  assert.equal(TIMEOUT_KEYS.includes('memory'), false);
});

test('a memory toggle is settable over the control WS and lands in the config', () => {
  withRealStore({ projects: [], teams: [] }, (driver, store) => {
    driver.send({ type: 'update-settings', settings: { memory: { enabled: true, retainDays: 90 } } });
    const updated = driver.sent.find((message) => message.type === 'settings-updated');
    assert.equal(updated.settings.memory.enabled, true);
    assert.equal(store.config.memory.retainDays, 90);
  });
});

// The load-bearing half of the relaxation: a knob crosses, a filename or a remembered byte does not.
test('a path or content-shaped memory key is refused by name and nothing is written', () => {
  for (const block of [{ dir: '/tmp/steal' }, { dbPath: '/tmp/steal.db' }, { text: REMEMBERED }]) {
    withRealStore({ projects: [], teams: [] }, (driver, store) => {
      driver.send({ type: 'update-settings', settings: { memory: { enabled: true, ...block } } });
      const error = driver.sent.find((message) => message.type === 'settings-error');
      assert.match(error.message, /^memory\.\w+ is not settable from the dashboard$/);
      assert.equal(driver.sent.some((message) => message.type === 'settings-updated'), false);
      assert.equal(store.config.memory, undefined);
    });
  }
});

test('an out-of-range memory toggle is refused rather than silently clamped by the resolver', () => {
  withRealStore({ projects: [], teams: [] }, (driver, store) => {
    driver.send({ type: 'update-settings', settings: { memory: { retainDays: 5 } } });
    const error = driver.sent.find((message) => message.type === 'settings-error');
    assert.equal(error.message, 'memory.retainDays must be an integer between 30 and 3650');
    assert.equal(store.config.memory, undefined);
  });
});

// A hand-set key the Mill tab does not render must survive a save, or the dialog silently unconfigures it.
test('a settings save merges onto the stored memory block instead of replacing it', () => {
  withRealStore({ projects: [], teams: [], memory: { enabled: false, futureKnob: 7 } }, (driver, store) => {
    driver.send({ type: 'update-settings', settings: { memory: { enabled: true } } });
    assert.equal(store.config.memory.enabled, true);
    assert.equal(store.config.memory.futureKnob, 7);
  });
});

test('nothing memory-shaped is replayable, so no future surface can be replayed onto a reconnect', () => {
  assert.deepEqual([...REPLAYABLE_EXACT].filter((type) => type.includes('memory')), []);
  assert.equal(isReplayable('memory-report'), false);
  assert.equal(isReplayable('memory-updated'), false);
});

test('the codex memory carrier contains only the pack index path, never a remembered byte', () => {
  const args = codex.renderPackArgs([{
    name: 'memory-glissa',
    dir: '/home/carbon/.glissa/packs/built/memory-glissa/current',
  }]);
  assert.equal(args.join('\n').includes(REMEMBERED), false);
  assert.equal(args.join('\n').includes('/data/'), false);
  assert.match(args[1], /memory-glissa: \/home\/carbon\/\.glissa\/packs\/built\/memory-glissa\/current\/CLAUDE\.md/);
});

test('the store logs counts and paths, never a remembered byte', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-negative-store-'));
  const lines = [];
  const store = createMemoryStore({
    dir,
    dbPath: path.join(dir, 'glissa.db'),
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: { log: (line) => lines.push(line), warn: (line) => lines.push(line) },
    debug: true,
    projectionDebounceMs: 5,
  });
  try {
    await store.append({
      kind: 'knowledge',
      layer: 'semantic',
      project: '/repos/glissa',
      source: { kind: 'reported', vendor: 'claude', sessionId: 'sess-1' },
      text: REMEMBERED,
    });
    await store.flushProjection();
    assert.equal(lines.join('\n').includes(REMEMBERED), false);
  } finally {
    await store.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
