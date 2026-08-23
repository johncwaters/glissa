'use strict';

// M16 of docs/plan-visions-3.md, "Enforced non-delivery": memory is a local, file-configured store whose
// content reaches a session and nothing else. These are the negative pins, so the guarantee cannot rot
// the day a dashboard surface is added: no memory-shaped control-WS message type exists at all, a
// remote-trust socket is answered without one, none is replayable, and no lane logs remembered text.

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

test('a remote-trust control socket is answered without a memory frame, and settings never echo the block', () => {
  withRealStore({ projects: [], teams: [], memory: LIVE_MEMORY }, (driver, store) => {
    driver.send({ type: 'get-settings' });
    driver.send({ type: 'request-mill-report' });
    // The socket really was answered: an empty transcript would pass every assertion below for free.
    assert.equal(driver.sent.length > 0, true);
    const types = driver.sent.map((message) => message.type);
    assert.equal(types.some((type) => String(type).includes('memory')), false);
    assert.equal(JSON.stringify(driver.sent).includes('memory'), false);
    assert.equal('memory' in store.getSettings(), false);
  });
});

test('memory appears in none of the settable key lists, so the store stays file-configured', () => {
  assert.equal(BOOLEAN_KEYS.includes('memory'), false);
  assert.equal(STRING_KEYS.includes('memory'), false);
  assert.equal(TIMEOUT_KEYS.includes('memory'), false);
});

test('nothing memory-shaped is replayable, so no future surface can be replayed onto a reconnect', () => {
  assert.deepEqual([...REPLAYABLE_EXACT].filter((type) => type.includes('memory')), []);
  assert.equal(isReplayable('memory-report'), false);
  assert.equal(isReplayable('memory-updated'), false);
});

test('the store logs counts and paths, never a remembered byte', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-negative-store-'));
  const lines = [];
  const store = createMemoryStore({
    dir,
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: { log: (line) => lines.push(line), warn: (line) => lines.push(line) },
    debug: true,
    projectionDebounceMs: 5,
    watchCanon: false,
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
