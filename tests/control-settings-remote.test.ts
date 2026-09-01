// Remote mode must be UNREACHABLE from the control WebSocket. That channel is unauthenticated on
// localhost by design, so if a settings save could write config.remote, any local process (or a
// browser page that got a socket) could turn on remote access, mint itself a listener and widen the
// trust boundary from inside. The only paths in are the config file and the CLI.
//
// These tests drive the REAL config store over a temp config.json (never ~/.glissa).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore } from '../server/config-store.ts';
import type { ConfigStore, GlissaConfig } from '../server/config-store.ts';
import { ConfigUpdate, HIDDEN_CONFIG_KEYS } from '../shared/contracts/index.ts';
import type { ControlConnection } from './helpers/control-harness.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

interface SettingsFrame {
  type: string;
  message?: string;
}

function harness(config: GlissaConfig, store: ConfigStore): ControlConnection<SettingsFrame> {
  const server = createControlServer(controlDeps(config, {
    configStore: store,
    applySettingsReload: (fresh) => store.applySettings(fresh),
  }));
  const connection = connectControl<SettingsFrame>(server);
  connection.sent.length = 0; // drop the connect preamble
  return connection;
}

function withRealStore(
  seed: Record<string, unknown>,
  fn: (h: ControlConnection<SettingsFrame>, store: ConfigStore, readDisk: () => Record<string, unknown>) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-remote-settings-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(seed, null, 2), 'utf8');
  const previous = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  try {
    const store = createConfigStore();
    fn(harness(store.config, store), store, () => JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } finally {
    if (previous == null) delete process.env.GLISSA_CONFIG;
    if (previous != null) process.env.GLISSA_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LIVE_REMOTE = { enabled: true, port: 3001, publicHost: 'glissa.test', allowedOrigins: ['https://glissa.test'] };

test('remote appears in none of the settable key lists', () => {
  assert.equal(HIDDEN_CONFIG_KEYS.includes('remote'), true);
  assert.equal('remote' in ConfigUpdate.shape, false);
});

test('getSettings never echoes the remote block to a control client', () => {
  withRealStore({ projects: [], remote: LIVE_REMOTE }, (_h, store) => {
    assert.equal('remote' in store.getSettings(), false);
  });
});

test('an update-settings carrying a remote key is rejected by name without a partial write', () => {
  withRealStore({ projects: [], remote: LIVE_REMOTE }, (h, store, readDisk) => {
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
    assert.match(String(h.sent.find((message) => message.type === 'settings-error')?.message), /remote/);
  });
});

test('a save cannot introduce a remote block where the config had none', () => {
  withRealStore({ projects: [] }, (h, _store, readDisk) => {
    h.send({
      type: 'update-settings',
      settings: { remote: { enabled: true, port: 4444 } },
    });
    assert.equal('remote' in readDisk(), false);
    assert.match(String(h.sent.find((message) => message.type === 'settings-error')?.message), /remote/);
  });
});

test('applySettings drops unknown keys, so a config hot-reload cannot clobber remote in memory', () => {
  withRealStore({ projects: [], remote: LIVE_REMOTE }, (_h, store) => {
    store.applySettings({ projects: [], cursorBlink: true, remote: { enabled: false, port: null } });
    assert.deepEqual(store.config.remote, LIVE_REMOTE, 'remote is not a key applySettings reads');
    assert.equal(store.config.cursorBlink, true);

    store.applySettings({ projects: [] });
    assert.deepEqual(store.config.remote, LIVE_REMOTE, 'nor is it cleared by its absence');
  });
});

test('applySettings ignores wholly unknown keys generally (the property remote relies on)', () => {
  withRealStore({ projects: [] }, (_h, store) => {
    store.applySettings({ projects: [], somethingInvented: 'value' });
    assert.equal('somethingInvented' in store.config, false);
  });
});
