// M16 of docs/plan-visions-3.md, "Enforced non-delivery", as relaxed to toggles-only: memory is a local
// store whose CONTENT reaches a session and nothing else, while its scalar knobs are dashboard settings
// like any other lane's. These are the negative pins: no memory-shaped control-WS message type exists at
// all, none is replayable, no lane logs remembered text, and the settings block accepts an allow-list of
// booleans and clamped integers, refusing a path or a content-shaped key BY NAME.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore } from '../server/config-store.ts';
import type { ConfigStore, GlissaConfig } from '../server/config-store.ts';
import { CONFIG_SCALAR_KEYS, ConfigUpdate } from '../shared/contracts/index.ts';
import { REPLAYABLE_EXACT, isReplayable } from '../server/control-replay-core.ts';
import { createMemoryStore } from '../server/memory-store.ts';
import { resolveMemoryConfig } from '../server/core/memory-core.ts';
import codex from '../session/adapters/codex.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import type { ControlConnection } from './helpers/control-harness.ts';

const SERVER_DIR = path.join(import.meta.dirname, '..', 'server');
const REMEMBERED = 'the merge gate lives in session/core/merge-gate.ts';

interface ControlFrame {
  type: string;
  message?: string;
  settings?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The settings projection answers Record<string, unknown> | null by design, so a suite reading two
// levels into it narrows here rather than at each assertion.
function block(value: unknown, ...keys: string[]): Record<string, unknown> {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) throw new Error(`the settings projection has no ${key} block`);
    current = current[key];
  }
  if (!isRecord(current)) throw new Error('the settings projection ends in no block at all');
  return current;
}

function harness(config: GlissaConfig, store: ConfigStore): ControlConnection<ControlFrame> {
  const server = createControlServer(controlDeps(config, {
    configStore: store,
    applySettingsReload: (next) => store.applySettings(next),
  }));
  return connectControl<ControlFrame>(server, { trust: 'remote' });
}

function withRealStore<T>(
  config: GlissaConfig,
  fn: (driver: ControlConnection<ControlFrame>, store: ConfigStore) => T,
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-negative-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
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
  const offenders: string[] = [];
  for (const name of fs.readdirSync(SERVER_DIR)) {
    if (!/\.(js|ts)$/.test(name)) continue;
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
    const { distill, ...scalars } = block(echoed);
    for (const value of [...Object.values(scalars), ...Object.values(block(distill))]) {
      assert.equal(typeof value === 'boolean' || typeof value === 'number', true);
    }
  });
});

// The way OUT is the same allow-list as the way in: a stored path is not echoable just because the
// operator put it in config.json themselves.
test('a file-only key of any Mill block is dropped from the settings echo', () => {
  withRealStore({ projects: [], teams: [], ...FILE_ONLY }, (driver, store) => {
    const settings = store.getSettings();
    assert.equal('dbPath' in block(settings.memory), false);
    assert.equal(block(settings.memory).enabled, true);
    assert.equal('roots' in block(settings.ingest, 'sources', 'fs'), false);
    assert.equal('shells' in block(settings.ingest, 'sources', 'shellHistory'), false);
    assert.equal(block(settings.ingest, 'sources', 'fs').enabled, true);
    assert.equal('packsDir' in block(settings.packDistiller), false);
    assert.equal(block(settings.packDistiller).enabled, true);
    driver.send({ type: 'get-settings' });
    const replied = driver.sent.find((message) => message.type === 'settings');
    assert.equal(JSON.stringify(replied).includes('/home/carbon/secrets'), false);
    assert.equal(JSON.stringify(replied).includes('glissa-memory.db'), false);
  });
});

test('memory is a block, never a scalar settings key, so no key list can carry a path into the config', () => {
  assert.equal(CONFIG_SCALAR_KEYS.includes('memory'), false);
  assert.equal('memory' in ConfigUpdate.shape, true);
});

test('a memory toggle is settable over the control WS and lands in the config', () => {
  withRealStore({ projects: [], teams: [] }, (driver, store) => {
    driver.send({ type: 'update-settings', settings: { memory: { enabled: true, retainDays: 90 } } });
    const updated = driver.sent.find((message) => message.type === 'settings-updated');
    assert.equal(block(updated?.settings, 'memory').enabled, true);
    assert.equal(block(store.config.memory).retainDays, 90);
  });
});

// The load-bearing half of the relaxation: a knob crosses, a filename or a remembered byte does not.
test('a path or content-shaped memory key is refused by name and nothing is written', () => {
  for (const forbidden of [{ dir: '/tmp/steal' }, { dbPath: '/tmp/steal.db' }, { text: REMEMBERED }]) {
    withRealStore({ projects: [], teams: [] }, (driver, store) => {
      driver.send({ type: 'update-settings', settings: { memory: { enabled: true, ...forbidden } } });
      const error = driver.sent.find((message) => message.type === 'settings-error');
      assert.match(String(error?.message), /^memory\.\w+ is not settable from the dashboard$/);
      assert.equal(driver.sent.some((message) => message.type === 'settings-updated'), false);
      assert.equal(store.config.memory, undefined);
    });
  }
});

test('an out-of-range memory toggle is refused rather than silently clamped by the resolver', () => {
  withRealStore({ projects: [], teams: [] }, (driver, store) => {
    driver.send({ type: 'update-settings', settings: { memory: { retainDays: 5 } } });
    const error = driver.sent.find((message) => message.type === 'settings-error');
    assert.equal(error?.message, 'memory.retainDays must be an integer between 30 and 3650');
    assert.equal(store.config.memory, undefined);
  });
});

// A hand-set key the Mill tab does not render must survive a save, or the dialog silently unconfigures it.
test('a settings save merges onto the stored memory block instead of replacing it', () => {
  withRealStore({ projects: [], teams: [], memory: { enabled: false, futureKnob: 7 } }, (driver, store) => {
    driver.send({ type: 'update-settings', settings: { memory: { enabled: true } } });
    assert.equal(block(store.config.memory).enabled, true);
    assert.equal(block(store.config.memory).futureKnob, 7);
  });
});

test('nothing memory-shaped is replayable, so no future surface can be replayed onto a reconnect', () => {
  assert.deepEqual([...REPLAYABLE_EXACT].filter((type) => type.includes('memory')), []);
  assert.equal(isReplayable('memory-report'), false);
  assert.equal(isReplayable('memory-updated'), false);
});

test('the codex memory carrier contains only the pack index path, never a remembered byte', () => {
  const args = codex.renderPackArgs(
    [{ name: 'memory-glissa', dir: '/home/carbon/.glissa/packs/built/memory-glissa/current' }],
    '/home/carbon/.glissa/packs/built',
  );
  assert.ok(args, 'a well-formed delivery renders its carrier');
  assert.equal(args.join('\n').includes(REMEMBERED), false);
  assert.equal(args.join('\n').includes('/data/'), false);
  assert.match(args[1], /memory-glissa: \/home\/carbon\/\.glissa\/packs\/built\/memory-glissa\/current\/CLAUDE\.md/);
});

test('the store logs counts and paths, never a remembered byte', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-negative-store-'));
  const lines: string[] = [];
  const store = createMemoryStore({
    dir,
    dbPath: path.join(dir, 'glissa.db'),
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: { log: (line: string) => { lines.push(line); }, warn: (line: string) => { lines.push(line); } },
    debug: true,
    projectionDebounceMs: 5,
  });
  if (!store) throw new Error('this node build has no node:sqlite');
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
