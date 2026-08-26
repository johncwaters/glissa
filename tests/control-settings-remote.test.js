'use strict';

// Remote mode must be UNREACHABLE from the control WebSocket. That channel is unauthenticated on
// localhost by design, so if a settings save could write config.remote, any local process (or a
// browser page that got a socket) could turn on remote access, mint itself a listener and widen the
// trust boundary from inside. The only paths in are the config file and the CLI.
//
// These tests drive the REAL config store over a temp config.json (never ~/.glissa) through the same
// harness control-settings.test.js uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerControlHandlers } = require('../server/control-handlers');
const { createConfigStore } = require('../server/config-store');
const { ConfigUpdate, HIDDEN_CONFIG_KEYS } = require('../shared/contracts');

function harness(cfg, store) {
  const controlWss = new EventEmitter();
  const sent = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: store,
    applyConfigReload: () => {},
    applySettingsReload: (c) => store.applySettings(c),
    broadcastControl: () => {},
  });
  controlWss.emit('connection', ws);
  sent.length = 0;
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent };
}

function withRealStore(cfg, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-remote-settings-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  const prev = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  try {
    const store = createConfigStore();
    return fn(harness(store.config, store), store, () => JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } finally {
    if (prev == null) delete process.env.GLISSA_CONFIG;
    if (prev != null) process.env.GLISSA_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LIVE_REMOTE = { enabled: true, port: 3001, publicHost: 'glissa.test', allowedOrigins: ['https://glissa.test'] };

test('remote appears in none of the settable key lists', () => {
  assert.equal(HIDDEN_CONFIG_KEYS.includes('remote'), true);
  assert.equal('remote' in ConfigUpdate.shape, false);
});

test('getSettings never echoes the remote block to a control client', () => {
  withRealStore({ projects: [], teams: [], remote: LIVE_REMOTE }, (_h, store) => {
    assert.equal('remote' in store.getSettings(), false);
  });
});

test('an update-settings carrying a remote key is rejected by name without a partial write', () => {
  withRealStore({ projects: [], teams: [], remote: LIVE_REMOTE }, (h, store, readDisk) => {
    h.send({
      type: 'update-settings',
      settings: {
        cursorBlink: true,
        remote: { enabled: true, port: 4444, publicHost: 'attacker.example', allowedOrigins: ['https://attacker.example'] },
      },
    });

    assert.deepEqual(readDisk().remote, LIVE_REMOTE, 'the file keeps the operator-set remote block');
    assert.deepEqual(store.config.remote, LIVE_REMOTE, 'and so does the in-memory config');
    assert.equal(readDisk().cursorBlink, undefined, 'the rejected update writes nothing');
    assert.match(h.sent.find((message) => message.type === 'settings-error').message, /remote/);
  });
});

test('a save cannot introduce a remote block where the config had none', () => {
  withRealStore({ projects: [], teams: [] }, (h, _store, readDisk) => {
    h.send({
      type: 'update-settings',
      settings: { remote: { enabled: true, port: 4444 } },
    });
    assert.equal('remote' in readDisk(), false);
    assert.match(h.sent.find((message) => message.type === 'settings-error').message, /remote/);
  });
});

test('applySettings drops unknown keys, so a config hot-reload cannot clobber remote in memory', () => {
  withRealStore({ projects: [], teams: [], remote: LIVE_REMOTE }, (_h, store) => {
    store.applySettings({ projects: [], cursorBlink: true, remote: { enabled: false, port: null } });
    assert.deepEqual(store.config.remote, LIVE_REMOTE, 'remote is not a key applySettings reads');
    assert.equal(store.config.cursorBlink, true);

    store.applySettings({ projects: [] });
    assert.deepEqual(store.config.remote, LIVE_REMOTE, 'nor is it cleared by its absence');
  });
});

test('applySettings ignores wholly unknown keys generally (the property remote relies on)', () => {
  withRealStore({ projects: [], teams: [] }, (_h, store) => {
    store.applySettings({ projects: [], somethingInvented: 'value' });
    assert.equal('somethingInvented' in store.config, false);
  });
});
