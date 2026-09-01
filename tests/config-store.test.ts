import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createConfigStore, ensureProjectIds, validateConfig, loadConfigFile, DEFAULT_CONFIG,
  CONFIG_FILE_MODE, SECRET_PRESENCE_SUFFIX,
} from '../server/config-store.ts';
import type { ConfigStore, DefaultConfig, GlissaConfig } from '../server/config-store.ts';
import { ConfigUpdate } from '../shared/contracts/index.ts';
import { SECRET_PRESENCE_SUFFIX as CLIENT_SECRET_PRESENCE_SUFFIX } from '../public/settings-view-core.ts';

type ConfigFileContent = Record<string, unknown>;
type StoreOptions = { settingsDefaults?: Partial<DefaultConfig> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function block(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('the settings projection carries no block here');
  return value;
}

function readJson(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return block(parsed);
}

function writeTmpConfig(cfg: ConfigFileContent): { dir: string; p: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-cfgstore-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return { dir, p };
}

function richConfig(overrides: ConfigFileContent = {}): ConfigFileContent {
  return {
    port: 4123,
    autoRecoverSeconds: 3,
    cursorBlink: false,
    repoRoots: ['/repo'],
    worktreeShare: ['node_modules'],
    remote: { enabled: false },
    projects: [{ id: 'p1', name: 'proj', path: '/repo/proj' }],
    ...overrides,
  };
}

function withStore<T>(
  cfg: ConfigFileContent,
  fn: (store: ConfigStore, configPath: string) => T,
  storeOpts?: StoreOptions,
): T {
  const { dir, p } = writeTmpConfig(cfg);
  const prev = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = p;
  try {
    return fn(createConfigStore(storeOpts), p);
  } finally {
    if (prev == null) delete process.env.GLISSA_CONFIG;
    if (prev != null) process.env.GLISSA_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ensureProjectIds assigns ids only where missing and reports change', () => {
  const projects = [{ name: 'a', path: 'C:/a' }, { id: 'keep-me', name: 'b', path: 'C:/b' }];
  assert.equal(ensureProjectIds(projects), true, 'changed: one project lacked an id');
  assert.ok(projects[0].id, 'missing id assigned');
  assert.equal(projects[1].id, 'keep-me', 'existing id untouched');
  assert.equal(ensureProjectIds(projects), false, 'second pass is a no-op');
});

test('validateConfig accepts lenient partial configs and unknown keys', () => {
  assert.deepEqual(validateConfig({ projects: [], custom: { any: true } }), { ok: true });
  assert.deepEqual(validateConfig({
    projects: [{ path: '/repo' }],
    port: 65535,
    autoRecoverSeconds: 0,
    cursorBlink: true,
    integrationBranch: 'develop',
    repoRoots: ['/repo'],
    worktreeShare: ['node_modules'],
    remote: {},
    unknownKey: 123,
  }), { ok: true });
});

test('config file compatibility keeps port zero and replayBufferKB zero', () => {
  withStore({ projects: [], port: 0, replayBufferKB: 0 }, (store) => {
    assert.equal(store.config.port, 0);
    assert.equal(store.config.replayBufferKB, 0);
  });
});

test('an invalid config file scalar falls back with a warning naming the key and value', () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  try {
    withStore({ projects: [], replayBufferKB: 20000 }, (store) => {
      assert.equal(store.config.replayBufferKB, DEFAULT_CONFIG.replayBufferKB);
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join('\n'), /replayBufferKB value 20000 is invalid; using 512/);
});

test('a legacy packReadTelemetry config key is ignored', () => {
  withStore({ projects: [], packReadTelemetry: false }, (store) => {
    assert.equal('packReadTelemetry' in store.getSettings(), false);
  });
});

test('validateConfig rejects malformed known fields', () => {
  const validation = validateConfig({
    projects: [{ id: 7 }],
    port: 70000,
    autoRecoverSeconds: Number.POSITIVE_INFINITY,
    cursorBlink: 'yes',
    integrationBranch: 3,
    repoRoots: ['/repo', 5],
    worktreeShare: 'node_modules',
    remote: [],
  });
  assert.equal(validation.ok, false);
  const errors = validation.ok ? [] : validation.errors;
  assert.match(errors.join('\n'), /projects\[0\]\.path must be a string/);
  assert.match(errors.join('\n'), /port must be an integer/);
  assert.match(errors.join('\n'), /autoRecoverSeconds must be a finite number/);
  assert.match(errors.join('\n'), /cursorBlink must be a boolean/);
  assert.match(errors.join('\n'), /integrationBranch must be a string/);
  assert.match(errors.join('\n'), /repoRoots must be an array of strings/);
  assert.match(errors.join('\n'), /worktreeShare must be an array of strings/);
  assert.match(errors.join('\n'), /remote must be a plain object/);
  assert.equal(validateConfig(null).ok, false);
  assert.equal(validateConfig([]).ok, false);
});

test('validateConfig rejects a config missing the projects key entirely', () => {
  const validation = validateConfig({ port: 4123 });
  assert.equal(validation.ok, false);
  assert.match((validation.ok ? [] : validation.errors).join('\n'), /projects must be an array/);
});

test('save writes an invalid.bak copy when the fresh read is corrupt JSON', () => {
  withStore(richConfig(), (store, p) => {
    fs.writeFileSync(p, '{ not json', 'utf8');
    assert.equal(store.save((cfg) => { cfg.port = 4124; }), null);
    assert.equal(fs.readFileSync(p, 'utf8'), '{ not json');
    assert.equal(fs.readFileSync(`${p}.invalid.bak`, 'utf8'), '{ not json');
  });
});

test('createConfigStore persists auto-assigned ids, stable across reloads', () => {
  const { dir, p } = writeTmpConfig({ projects: [{ name: 'proj', path: 'C:/proj' }] });
  const prev = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = p;
  try {
    const first = createConfigStore();
    const id = first.config.projects[0].id;
    assert.ok(id, 'id assigned on first load');
    const onDiskProjects = readJson(p).projects;
    assert.ok(Array.isArray(onDiskProjects));
    assert.equal(block(onDiskProjects[0]).id, id, 'assigned id persisted to disk');
    const second = createConfigStore();
    assert.equal(second.config.projects[0].id, id, 'same id on reload (stable session identity)');
  } finally {
    if (prev == null) delete process.env.GLISSA_CONFIG;
    if (prev != null) process.env.GLISSA_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createConfigStore writes a boot snapshot of the loaded config', () => {
  const original = { projects: [{ name: 'proj', path: 'C:/proj' }] };
  const { dir, p } = writeTmpConfig(original);
  const prev = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = p;
  try {
    createConfigStore();
    assert.deepEqual(readJson(`${p}.boot.bak`), original);
  } finally {
    if (prev == null) delete process.env.GLISSA_CONFIG;
    if (prev != null) process.env.GLISSA_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save is an atomic read-modify-write round-trip', () => {
  withStore({ projects: [] }, (store, p) => {
    const out = store.save((cfg) => { cfg.projects.push({ id: 'x1', name: 'x', path: 'C:/x' }); });
    assert.equal(out?.projects.length, 1, 'returns the mutated config');
    const onDiskProjects = readJson(p).projects;
    assert.ok(Array.isArray(onDiskProjects));
    assert.equal(block(onDiskProjects[0]).id, 'x1', 'mutation written to disk');
  });
});

test('save returns null when the config file is unreadable', () => {
  withStore({ projects: [] }, (store, p) => {
    fs.rmSync(p);
    assert.equal(store.save((cfg) => { cfg.projects = []; }), null);
  });
});

test('save refuses an invalid fresh read without writing', () => {
  withStore(richConfig(), (store, p) => {
    const invalidContent = JSON.stringify({ projects: [{ id: 'missing-path' }] }, null, 2);
    fs.writeFileSync(p, invalidContent, 'utf8');
    assert.equal(store.save((cfg) => { cfg.port = 4124; }), null);
    assert.equal(fs.readFileSync(p, 'utf8'), invalidContent);
  });
});

test('save refuses an invalid mutation result without writing', () => {
  withStore(richConfig(), (store, p) => {
    const before = fs.readFileSync(p, 'utf8');
    assert.equal(store.save((cfg) => { cfg.port = 70000; }), null);
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  });
});

test('save refuses a suspected external wipe without laundering it', () => {
  withStore(richConfig(), (store, p) => {
    const wipedContent = JSON.stringify({ projects: [] }, null, 2);
    fs.writeFileSync(p, wipedContent, 'utf8');
    assert.equal(store.save((cfg) => { cfg.projects.push({ id: 'x', name: 'x', path: '/x' }); }), null);
    assert.equal(fs.readFileSync(p, 'utf8'), wipedContent);
  });
});

test('save writes a rolling backup before replacing changed config content', () => {
  withStore(richConfig(), (store, p) => {
    const before = readJson(p);
    const out = store.save((cfg) => { cfg.port = 4124; });
    assert.equal(out?.port, 4124);
    assert.deepEqual(readJson(`${p}.bak`), before);
    assert.equal(readJson(p).port, 4124);
  });
});

test('loadConfigFile saves corrupt JSON aside and returns the startup error when requested', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-cfgstore-corrupt-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, '{ not json', 'utf8');
  try {
    const loaded = loadConfigFile(p, { exitOnError: false });
    if (!('error' in loaded)) throw new Error('corrupt JSON must report a startup error');
    assert.ok(loaded.error);
    assert.match(loaded.message, /Could not load/);
    assert.match(loaded.message, /config\.json\.boot\.bak/);
    assert.match(loaded.message, /config\.json\.bak/);
    assert.equal(fs.readFileSync(`${p}.invalid.bak`, 'utf8'), '{ not json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getSettings falls back to DEFAULT_CONFIG for absent keys', () => {
  withStore({ projects: [] }, (store) => {
    const s = store.getSettings();
    assert.equal(s.cursorBlink, DEFAULT_CONFIG.cursorBlink);
    assert.equal(s.detectBackgroundAgents, DEFAULT_CONFIG.detectBackgroundAgents);
    assert.equal(s.rtk, DEFAULT_CONFIG.rtk);
    assert.equal(s.integrationBranch, DEFAULT_CONFIG.integrationBranch);
    assert.deepEqual(s.worktreeShare, DEFAULT_CONFIG.worktreeShare);
  });
});

test('getSettings projects only dashboard-settable mill measurement fields', () => {
  withStore({
    projects: [],
    millMetrics: { retainDays: 180, recordsPath: '/operator-only' },
  }, (store) => {
    assert.deepEqual(store.getSettings().millMetrics, { retainDays: 180 });
  });
});

test('settingsDefaults overlays a key the config file omits', () => {
  withStore({ projects: [] }, (store) => {
    assert.equal(DEFAULT_CONFIG.debugMode, false, 'the production default is off');
    assert.equal(store.getSettings().debugMode, true, 'the launch default fills the absent key');
  }, { settingsDefaults: { debugMode: true } });
});

test('an explicit config value beats settingsDefaults', () => {
  withStore({ projects: [], debugMode: false }, (store) => {
    assert.equal(store.getSettings().debugMode, false, 'the user setting always wins');
  }, { settingsDefaults: { debugMode: true } });
});

test('an explicit auto branch beats a launch branch default', () => {
  withStore({ projects: [], integrationBranch: null }, (store) => {
    assert.equal(store.getSettings().integrationBranch, null);
  }, { settingsDefaults: { integrationBranch: 'release' } });
});

test('settingsDefaults is never persisted and leaves other keys on DEFAULT_CONFIG', () => {
  withStore({ projects: [] }, (store, p) => {
    store.getSettings();
    assert.equal('debugMode' in readJson(p), false, 'a launch default writes nothing to config.json');
    assert.equal(store.getSettings().cursorBlink, DEFAULT_CONFIG.cursorBlink, 'unrelated keys are untouched');
  }, { settingsDefaults: { debugMode: true } });
});

test('no settingsDefaults option keeps plain DEFAULT_CONFIG behavior', () => {
  withStore({ projects: [] }, (store) => {
    assert.equal(store.getSettings().debugMode, DEFAULT_CONFIG.debugMode);
  });
});

test('applySettings applies each runtime scalar it is handed', () => {
  withStore({ projects: [] }, (store) => {
    store.applySettings({
      projects: [], cursorBlink: true, debugMode: false, autoRecoverSeconds: 7, integrationBranch: '123',
    });
    assert.equal(store.config.cursorBlink, true);
    assert.equal(store.config.debugMode, false);
    assert.equal(store.config.autoRecoverSeconds, 7, 'timeout applied');
    assert.equal(store.config.integrationBranch, '123');
  });
});

test('applySettings stores an empty or null integration branch as auto', () => {
  withStore({ projects: [], integrationBranch: 'release' }, (store) => {
    store.applySettings({ integrationBranch: '' });
    assert.equal(store.config.integrationBranch, null);
    store.config.integrationBranch = 'release';
    store.applySettings({ integrationBranch: null });
    assert.equal(store.config.integrationBranch, null);
  });
});

test('applySettings never live-applies the listener port', () => {
  withStore({ projects: [], port: 4123 }, (store) => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      store.applySettings({ projects: [], port: 4999, cursorBlink: true });
    } finally {
      console.log = originalLog;
    }
    assert.equal(store.config.port, 4123);
    assert.equal(store.config.cursorBlink, true);
  });
});

test('rtk is a settable top-level boolean', () => {
  withStore({ projects: [] }, (store) => {
    store.applySettings({ projects: [], rtk: true });
    assert.equal(store.config.rtk, true);
    assert.equal(store.getSettings().rtk, true);
    store.applySettings({ projects: [], rtk: false });
    assert.equal(store.config.rtk, false);
  });
});

test('getSettings resolves branchGc defaults while opt-in blocks stay null; projectChoices derives from projects', () => {
  withStore({ projects: [{ id: 'p1', name: 'proj-one', path: 'C:/p1' }] }, (store) => {
    const s = store.getSettings();
    assert.equal(s.prReview, null);
    assert.deepEqual(s.branchGc, DEFAULT_CONFIG.branchGc);
    assert.equal(s.visions, null);
    assert.equal(s.telegram, null);
    assert.deepEqual(s.projectChoices, [{ id: 'p1', name: 'proj-one' }]);

    store.config.prReview = { enabled: true, projects: ['p1'] };
    store.config.branchGc = { ...DEFAULT_CONFIG.branchGc, enabled: false, staleDays: 21 };
    store.config.visions = { enabled: true, dispatch: { enabled: false } };
    store.config.telegram = { botToken: 'tok', chatId: '123' };
    const s2 = store.getSettings();
    assert.deepEqual(s2.prReview, { enabled: true, projects: ['p1'] });
    assert.deepEqual(s2.branchGc, { enabled: false, staleDays: 21, intervalMs: DEFAULT_CONFIG.branchGc.intervalMs });
    assert.deepEqual(s2.visions, { enabled: true, dispatch: { enabled: false } });
    assert.deepEqual(s2.telegram, { chatId: '123', botTokenConfigured: true });
  });
});

test('getSettings redacts the telegram bot token and the PostHog api key to presence flags', () => {
  withStore({ projects: [] }, (store) => {
    store.config.telegram = { botToken: 'tok-secret', chatId: '123' };
    store.config.posthog = { enabled: true, host: 'https://us.posthog.com', apiKey: 'phx_secret', repoPath: '/repo' };
    const settings = store.getSettings();

    assert.equal(SECRET_PRESENCE_SUFFIX, CLIENT_SECRET_PRESENCE_SUFFIX, 'the wire convention the dashboard hydrates from');
    assert.equal(JSON.stringify(settings).includes('tok-secret'), false, 'no bot token anywhere in the payload');
    assert.equal(JSON.stringify(settings).includes('phx_secret'), false, 'no api key anywhere in the payload');
    assert.equal(Object.hasOwn(block(settings.telegram), 'botToken'), false);
    assert.equal(Object.hasOwn(block(settings.posthog), 'apiKey'), false);
    assert.equal(block(settings.telegram).botTokenConfigured, true);
    assert.equal(block(settings.posthog).apiKeyConfigured, true);
    assert.deepEqual(settings.telegram, { chatId: '123', botTokenConfigured: true });

    store.config.telegram = { botToken: '', chatId: '123' };
    store.config.posthog = { enabled: false };
    const cleared = store.getSettings();
    assert.equal(block(cleared.telegram).botTokenConfigured, false, 'an empty string is not a stored credential');
    assert.equal(block(cleared.posthog).apiKeyConfigured, false);
  });
});

test('getSettings drops posthog keys outside the dashboard allow-list', () => {
  withStore({ projects: [] }, (store) => {
    store.config.posthog = { enabled: true, apiKey: 'phx_secret', internalOnlyKey: 'leak-me' };
    const settings = store.getSettings();

    assert.equal(Object.hasOwn(block(settings.posthog), 'internalOnlyKey'), false);
    assert.deepEqual(settings.posthog, { enabled: true, apiKeyConfigured: true });
  });
});

test('applySettings preserves branchGc defaults and merges partial overrides', () => {
  withStore({ projects: [] }, (store) => {
    store.applySettings({ projects: [], cursorBlink: true });
    assert.equal(store.config.prReview, undefined, 'absent on the incoming config leaves it untouched');
    assert.deepEqual(store.config.branchGc, DEFAULT_CONFIG.branchGc);
    assert.equal(store.config.visions, undefined);
    assert.equal(store.config.telegram, undefined);

    store.applySettings({
      projects: [],
      prReview: { enabled: true },
      branchGc: { enabled: false },
      visions: { enabled: true },
      telegram: { botToken: 'x', chatId: 'y' },
    });
    assert.deepEqual(store.config.prReview, { enabled: true });
    assert.deepEqual(store.config.branchGc, { ...DEFAULT_CONFIG.branchGc, enabled: false });
    assert.deepEqual(store.config.visions, { enabled: true });
    assert.deepEqual(store.config.telegram, { botToken: 'x', chatId: 'y' });
  });
});

test('branchGc defaults survive a config save round trip', () => {
  withStore({ projects: [] }, (store, configPath) => {
    const saved = store.save((config) => { config.cursorBlink = true; });

    assert.equal(saved?.branchGc, undefined);
    assert.deepEqual(store.config.branchGc, DEFAULT_CONFIG.branchGc);
    assert.deepEqual(store.getSettings().branchGc, DEFAULT_CONFIG.branchGc);
    assert.equal(readJson(configPath).branchGc, undefined);
  });
});

test('a partial branchGc config merges over the defaults', () => {
  withStore({ branchGc: { enabled: false }, projects: [] }, (store) => {
    assert.deepEqual(store.config.branchGc, { ...DEFAULT_CONFIG.branchGc, enabled: false });
  });
});

const WATCH_DEADLINE_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + WATCH_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  assert.fail(`${message} (waited ${WATCH_DEADLINE_MS}ms)`);
}

async function withStoreAsync<T>(
  cfg: ConfigFileContent,
  fn: (store: ConfigStore, configPath: string) => Promise<T>,
): Promise<T> {
  const { dir, p } = writeTmpConfig(cfg);
  const prev = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = p;
  try {
    return await fn(createConfigStore(), p);
  } finally {
    if (prev == null) delete process.env.GLISSA_CONFIG;
    if (prev != null) process.env.GLISSA_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('watchForChanges still sees a hand-edit after a save replaced the file inode', async () => {
  await withStoreAsync({ projects: [] }, async (store, p) => {
    const reloads: GlissaConfig[] = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      store.save((cfg) => { cfg.projects.push({ id: 'from-save', name: 's', path: 'C:/s' }); });

      await sleep(1200);
      assert.equal(reloads.length, 0, 'a self-write does not reload');

      fs.writeFileSync(p, JSON.stringify({ projects: [{ id: 'hand-edit', name: 'h', path: 'C:/h' }] }, null, 2), 'utf8');
      await waitFor(() => reloads.length > 0, 'hand-edit after a save never reloaded');
      assert.equal(reloads[reloads.length - 1].projects[0].id, 'hand-edit', 'callback carries the edited content');
    } finally {
      stop();
    }
  });
});

test('watchForChanges rejects invalid and wiped config edits', async () => {
  await withStoreAsync(richConfig(), async (store, p) => {
    const reloads: GlissaConfig[] = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      fs.writeFileSync(p, JSON.stringify({ projects: [{ id: 'bad' }] }, null, 2), 'utf8');
      await sleep(1200);
      assert.equal(reloads.length, 0, 'invalid config must not reload');

      fs.writeFileSync(p, JSON.stringify({ projects: [] }, null, 2), 'utf8');
      await sleep(1200);
      assert.equal(reloads.length, 0, 'wiped config must not reload');

      fs.writeFileSync(p, JSON.stringify(richConfig({ port: 4124 }), null, 2), 'utf8');
      await waitFor(() => reloads.length > 0, 'valid config after rejected edits never reloaded');
      assert.equal(reloads[0].port, 4124);
    } finally {
      stop();
    }
  });
});

test('watchForChanges ignores directory events for other files', async () => {
  await withStoreAsync({ projects: [] }, async (store, p) => {
    const reloads: GlissaConfig[] = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      fs.writeFileSync(`${p}.tmp.9999`, 'not the config', 'utf8');
      fs.writeFileSync(path.join(path.dirname(p), 'unrelated.json'), '{}', 'utf8');
      await sleep(1200);
      assert.equal(reloads.length, 0, 'a sibling write is not a config change');
    } finally {
      stop();
    }
  });
});

test('watchForChanges returns a closer that releases the fs.watch handle', () => {
  withStore({ projects: [] }, (store) => {
    const stop = store.watchForChanges(() => {});
    assert.equal(typeof stop, 'function', 'returns a closer');
    assert.doesNotThrow(stop);
    assert.doesNotThrow(stop, 'idempotent');
  });
});

test('a hand-edit landing immediately after a self-write is applied, not swallowed', async () => {
  await withStoreAsync({ projects: [] }, async (store, p) => {
    const reloads: GlissaConfig[] = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      store.save((cfg) => { cfg.projects.push({ id: 'from-save', name: 's', path: 'C:/s' }); });

      fs.writeFileSync(p, JSON.stringify({
        projects: [{ id: 'from-save', name: 's', path: 'C:/s' }], port: 4321,
      }, null, 2), 'utf8');
      await waitFor(() => reloads.length > 0, 'the hand-edit was swallowed as a self-write');
      assert.equal(reloads[reloads.length - 1].port, 4321);
    } finally {
      stop();
    }
  });
});

test('a self-write is still suppressed, however many events it produces', async () => {
  await withStoreAsync({ projects: [] }, async (store) => {
    const reloads: GlissaConfig[] = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      store.save((cfg) => { cfg.projects.push({ id: 'a', name: 'a', path: 'C:/a' }); });
      await sleep(1200);
      store.save((cfg) => { cfg.projects.push({ id: 'b', name: 'b', path: 'C:/b' }); });
      await sleep(1200);
      assert.deepEqual(reloads, [], 'a save must never reload its own write back through the settings path');
    } finally {
      stop();
    }
  });
});

test('reverting a hand-edit back to previously written bytes still reloads', async () => {
  await withStoreAsync({ projects: [] }, async (store, p) => {
    const reloads: GlissaConfig[] = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      store.save((cfg) => { cfg.projects.push({ id: 'from-save', name: 's', path: 'C:/s' }); });
      await sleep(1200);
      assert.equal(reloads.length, 0, 'the save itself is suppressed');
      const written = fs.readFileSync(p, 'utf8');

      fs.writeFileSync(p, JSON.stringify({
        projects: [{ id: 'from-save', name: 's', path: 'C:/s' }], port: 4321,
      }, null, 2), 'utf8');
      await waitFor(() => reloads.length > 0, 'the hand-edit never reloaded');

      fs.writeFileSync(p, written, 'utf8');
      await waitFor(() => reloads.length > 1, 'the revert was swallowed as a stale self-write');
      assert.equal(reloads[reloads.length - 1].port, undefined, 'the reverted content is what was applied');
    } finally {
      stop();
    }
  });
});

test('a duplicate event for content already applied is not re-applied', async () => {
  await withStoreAsync({ projects: [] }, async (store, p) => {
    const reloads: GlissaConfig[] = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      const edited = JSON.stringify({ projects: [{ id: 'hand', name: 'h', path: 'C:/h' }] }, null, 2);
      fs.writeFileSync(p, edited, 'utf8');
      await waitFor(() => reloads.length > 0, 'the hand-edit never reloaded');

      fs.writeFileSync(p, edited, 'utf8');
      await sleep(1200);
      assert.equal(reloads.length, 1);
    } finally {
      stop();
    }
  });
});

test('phoneEscalationMs is a settable timeout key with the five-minute default', async () => {
  assert.equal('phoneEscalationMs' in ConfigUpdate.shape, true);
  assert.equal(DEFAULT_CONFIG.phoneEscalationMs, 300000);

  await withStoreAsync({ projects: [] }, async (store) => {
    assert.equal(store.getSettings().phoneEscalationMs, 300000, 'an absent key reports the default');
    store.applySettings({ projects: [], phoneEscalationMs: 0 });
    assert.equal(store.config.phoneEscalationMs, 0, 'and zero, which switches the rung off, survives');
  });
});

test('reverting to bytes that were applied before a save still reloads', async () => {
  await withStoreAsync({ projects: [] }, async (store, p) => {
    const reloads: GlissaConfig[] = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      const handEdited = JSON.stringify({
        projects: [{ id: 'hand', name: 'h', path: 'C:/h' }], port: 4100,
      }, null, 2);
      fs.writeFileSync(p, handEdited, 'utf8');
      await waitFor(() => reloads.length > 0, 'the hand-edit never reloaded');

      store.save((cfg) => { cfg.port = 4200; });
      await sleep(1200);
      assert.equal(reloads.length, 1, 'the save itself is still suppressed');

      fs.writeFileSync(p, handEdited, 'utf8');
      await waitFor(() => reloads.length > 1, 'the revert was swallowed as a stale applied-signature');
      assert.equal(reloads[reloads.length - 1].port, 4100, 'the reverted content is what was applied');
    } finally {
      stop();
    }
  });
});

test('a saved config.json, and its backup, are owner-only', { skip: process.platform === 'win32' }, async () => {
  await withStoreAsync(richConfig(), async (store, p) => {
    fs.chmodSync(p, 0o644);
    assert.ok(store.save((cfg) => { cfg.port = 4999; }), 'the save succeeded');

    assert.equal(fs.statSync(p).mode & 0o777, CONFIG_FILE_MODE, 'the save repairs a world-readable config');
    assert.equal(fs.statSync(`${p}.bak`).mode & 0o777, CONFIG_FILE_MODE, 'the backup carries the same bytes, so the same mode');
    assert.equal(fs.statSync(`${p}.boot.bak`).mode & 0o777, CONFIG_FILE_MODE, 'and so does the boot backup');
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).port, 4999, 'and the content still landed');
  });
});
