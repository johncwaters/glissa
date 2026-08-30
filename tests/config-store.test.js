'use strict';

// config-store owns config.json load/save and ensureProjectIds (the stable session identity every
// Map/route/control-message keys off). Every test points createConfigStore at a FRESH temp config via
// GLISSA_CONFIG; it must never fall through to the repo's real config.json (resolveConfigPath order:
// env > local config.json > home).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createConfigStore, ensureProjectIds, validateConfig, loadConfigFile, DEFAULT_CONFIG, SECRET_PRESENCE_SUFFIX,
} = require('../server/config-store');

function writeTmpConfig(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-cfgstore-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return { dir, p };
}

function richConfig(overrides = {}) {
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

// Runs fn with GLISSA_CONFIG pointed at a temp config, then restores env + disk. storeOpts is
// passed straight to createConfigStore (the per-launch settingsDefaults the dev server uses).
function withStore(cfg, fn, storeOpts) {
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
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
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
  assert.match(validation.errors.join('\n'), /projects\[0\]\.path must be a string/);
  assert.match(validation.errors.join('\n'), /port must be an integer/);
  assert.match(validation.errors.join('\n'), /autoRecoverSeconds must be a finite number/);
  assert.match(validation.errors.join('\n'), /cursorBlink must be a boolean/);
  assert.match(validation.errors.join('\n'), /integrationBranch must be a string/);
  assert.match(validation.errors.join('\n'), /repoRoots must be an array of strings/);
  assert.match(validation.errors.join('\n'), /worktreeShare must be an array of strings/);
  assert.match(validation.errors.join('\n'), /remote must be a plain object/);
  assert.equal(validateConfig(null).ok, false);
  assert.equal(validateConfig([]).ok, false);
});

test('validateConfig rejects a config missing the projects key entirely', () => {
  const validation = validateConfig({ port: 4123 });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /projects must be an array/);
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
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(onDisk.projects[0].id, id, 'assigned id persisted to disk');
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
    assert.deepEqual(JSON.parse(fs.readFileSync(`${p}.boot.bak`, 'utf8')), original);
  } finally {
    if (prev == null) delete process.env.GLISSA_CONFIG;
    if (prev != null) process.env.GLISSA_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save is an atomic read-modify-write round-trip', () => {
  withStore({ projects: [] }, (store, p) => {
    const out = store.save((cfg) => { cfg.projects.push({ id: 'x1', name: 'x', path: 'C:/x' }); });
    assert.equal(out.projects.length, 1, 'returns the mutated config');
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(onDisk.projects[0].id, 'x1', 'mutation written to disk');
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
    assert.equal(store.save((cfg) => { cfg.projects.push({ id: 'x', path: '/x' }); }), null);
    assert.equal(fs.readFileSync(p, 'utf8'), wipedContent);
  });
});

test('save writes a rolling backup before replacing changed config content', () => {
  withStore(richConfig(), (store, p) => {
    const before = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = store.save((cfg) => { cfg.port = 4124; });
    assert.equal(out.port, 4124);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${p}.bak`, 'utf8')), before);
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).port, 4124);
  });
});

test('loadConfigFile saves corrupt JSON aside and returns the startup error when requested', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-cfgstore-corrupt-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, '{ not json', 'utf8');
  try {
    const loaded = loadConfigFile(p, { exitOnError: false });
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

// The dev server (vite.config.js) turns debugMode on this way: a fallback for a key config.json
// omits, never a persisted value, and never a win over an explicit setting.
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
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal('debugMode' in onDisk, false, 'a launch default writes nothing to config.json');
    assert.equal(store.getSettings().cursorBlink, DEFAULT_CONFIG.cursorBlink, 'unrelated keys are untouched');
  }, { settingsDefaults: { debugMode: true } });
});

test('no settingsDefaults option keeps plain DEFAULT_CONFIG behavior', () => {
  withStore({ projects: [] }, (store) => {
    assert.equal(store.getSettings().debugMode, DEFAULT_CONFIG.debugMode);
  });
});

test('applySettings coerces booleans and strings and applies timeouts', () => {
  withStore({ projects: [] }, (store) => {
    store.applySettings({ cursorBlink: 1, debugMode: 0, autoRecoverSeconds: 7, integrationBranch: 123 });
    assert.equal(store.config.cursorBlink, true, 'boolean coerced');
    assert.equal(store.config.debugMode, false, 'falsy boolean coerced');
    assert.equal(store.config.autoRecoverSeconds, 7, 'timeout applied');
    assert.equal(store.config.integrationBranch, '123', 'string coerced');
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
      store.applySettings({ port: 4999, cursorBlink: true });
    } finally {
      console.log = originalLog;
    }
    assert.equal(store.config.port, 4123);
    assert.equal(store.config.cursorBlink, true);
  });
});

test('rtk is a settable top-level boolean', () => {
  withStore({ projects: [] }, (store) => {
    store.applySettings({ rtk: true });
    assert.equal(store.config.rtk, true);
    assert.equal(store.getSettings().rtk, true);
    store.applySettings({ rtk: false });
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

test('getSettings redacts the telegram bot token and the PostHog api key to presence flags', async () => {
  const { SECRET_PRESENCE_SUFFIX: clientSuffix } = await import('../public/settings-view-core.mjs');
  withStore({ projects: [] }, (store) => {
    store.config.telegram = { botToken: 'tok-secret', chatId: '123' };
    store.config.posthog = { enabled: true, host: 'https://us.posthog.com', apiKey: 'phx_secret', repoPath: '/repo' };
    const settings = store.getSettings();

    assert.equal(SECRET_PRESENCE_SUFFIX, clientSuffix, 'the wire convention the dashboard hydrates from');
    assert.equal(JSON.stringify(settings).includes('tok-secret'), false, 'no bot token anywhere in the payload');
    assert.equal(JSON.stringify(settings).includes('phx_secret'), false, 'no api key anywhere in the payload');
    assert.equal(Object.hasOwn(settings.telegram, 'botToken'), false);
    assert.equal(Object.hasOwn(settings.posthog, 'apiKey'), false);
    assert.equal(settings.telegram.botTokenConfigured, true);
    assert.equal(settings.posthog.apiKeyConfigured, true);
    assert.deepEqual(settings.telegram, { chatId: '123', botTokenConfigured: true });

    store.config.telegram = { botToken: '', chatId: '123' };
    store.config.posthog = { enabled: false };
    const cleared = store.getSettings();
    assert.equal(cleared.telegram.botTokenConfigured, false, 'an empty string is not a stored credential');
    assert.equal(cleared.posthog.apiKeyConfigured, false);
  });
});

test('getSettings drops posthog keys outside the dashboard allow-list', () => {
  withStore({ projects: [] }, (store) => {
    store.config.posthog = { enabled: true, apiKey: 'phx_secret', internalOnlyKey: 'leak-me' };
    const settings = store.getSettings();

    assert.equal(Object.hasOwn(settings.posthog, 'internalOnlyKey'), false);
    assert.deepEqual(settings.posthog, { enabled: true, apiKeyConfigured: true });
  });
});

test('applySettings preserves branchGc defaults and merges partial overrides', () => {
  withStore({ projects: [] }, (store) => {
    store.applySettings({ cursorBlink: true });
    assert.equal(store.config.prReview, undefined, 'absent on the incoming config leaves it untouched');
    assert.deepEqual(store.config.branchGc, DEFAULT_CONFIG.branchGc);
    assert.equal(store.config.visions, undefined);
    assert.equal(store.config.telegram, undefined);

    store.applySettings({
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

    assert.equal(saved.branchGc, undefined);
    assert.deepEqual(store.config.branchGc, DEFAULT_CONFIG.branchGc);
    assert.deepEqual(store.getSettings().branchGc, DEFAULT_CONFIG.branchGc);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).branchGc, undefined);
  });
});

test('a partial branchGc config merges over the defaults', () => {
  withStore({ branchGc: { enabled: false }, projects: [] }, (store) => {
    assert.deepEqual(store.config.branchGc, { ...DEFAULT_CONFIG.branchGc, enabled: false });
  });
});

// The reload debounce is 500ms and a self-write suppresses for 500ms after it, so every wait here is
// a generous multiple of that: these poll to a deadline rather than sleeping a fixed amount.
const WATCH_DEADLINE_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + WATCH_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  assert.fail(`${message} (waited ${WATCH_DEADLINE_MS}ms)`);
}

// Runs fn with GLISSA_CONFIG pointed at a temp config, awaiting it before cleanup.
async function withStoreAsync(cfg, fn) {
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

// The regression this guards: save() commits by tmp+rename, replacing the inode. fs.watch on the
// FILE is an inotify watch on that inode, so on Linux the watcher silently followed the dead file
// and no later hand-edit of config.json ever reloaded. Watching the parent directory survives it.
test('watchForChanges still sees a hand-edit after a save replaced the file inode', async () => {
  await withStoreAsync({ projects: [] }, async (store, p) => {
    const reloads = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      store.save((cfg) => { cfg.projects.push({ id: 'from-save', name: 's', path: 'C:/s' }); });
      // Past both the debounce and the self-write suppression window, so the save itself is settled
      // and cannot be mistaken for the hand-edit below.
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
    const reloads = [];
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
    const reloads = [];
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

// The self-write suppression was a 500ms window, and the window WAS the bug: an operator editing
// config.json right after a hook-driven persist (resumeSessionId is written on every hook payload
// carrying a new session id) had their edit silently dropped until they saved again. Suppression is
// now by written-content signature, so it swallows exactly the echo (2026-08 review, section 7).
test('a hand-edit landing immediately after a self-write is applied, not swallowed', async () => {
  await withStoreAsync({ projects: [] }, async (store, p) => {
    const reloads = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      store.save((cfg) => { cfg.projects.push({ id: 'from-save', name: 's', path: 'C:/s' }); });
      // No pause at all: this is the race the time window lost.
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
    const reloads = [];
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

// The signature must not outlive the state it describes. A hand-edit reload changes memory without
// writing anything, so a signature still naming the LAST WRITTEN bytes made an operator's revert back
// to exactly those bytes look like Glissa's own echo: silently dropped, with memory and file left
// disagreeing and no way to notice.
test('reverting a hand-edit back to previously written bytes still reloads', async () => {
  await withStoreAsync({ projects: [] }, async (store, p) => {
    const reloads = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      store.save((cfg) => { cfg.projects.push({ id: 'from-save', name: 's', path: 'C:/s' }); });
      await sleep(1200);
      assert.equal(reloads.length, 0, 'the save itself is suppressed');
      const written = fs.readFileSync(p, 'utf8');

      // The operator edits away from what Glissa wrote...
      fs.writeFileSync(p, JSON.stringify({
        projects: [{ id: 'from-save', name: 's', path: 'C:/s' }], port: 4321,
      }, null, 2), 'utf8');
      await waitFor(() => reloads.length > 0, 'the hand-edit never reloaded');

      // ...and then reverts, byte for byte, to what Glissa had written earlier.
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
    const reloads = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      const edited = JSON.stringify({ projects: [{ id: 'hand', name: 'h', path: 'C:/h' }] }, null, 2);
      fs.writeFileSync(p, edited, 'utf8');
      await waitFor(() => reloads.length > 0, 'the hand-edit never reloaded');
      // Same bytes again: a second fs event for one logical edit changes nothing.
      fs.writeFileSync(p, edited, 'utf8');
      await sleep(1200);
      assert.equal(reloads.length, 1);
    } finally {
      stop();
    }
  });
});

// The escalation ladder's delay is an operator-facing timeout like every other one, not a constant
// buried in the manager.
test('phoneEscalationMs is a settable timeout key with the five-minute default', async () => {
  const { DEFAULT_CONFIG } = require('../server/config-store');
  const { ConfigUpdate } = require('../shared/contracts');
  assert.equal('phoneEscalationMs' in ConfigUpdate.shape, true);
  assert.equal(DEFAULT_CONFIG.phoneEscalationMs, 300000);

  await withStoreAsync({ projects: [] }, async (store) => {
    assert.equal(store.getSettings().phoneEscalationMs, 300000, 'an absent key reports the default');
    store.applySettings({ phoneEscalationMs: 0 });
    assert.equal(store.config.phoneEscalationMs, 0, 'and zero, which switches the rung off, survives');
  });
});

// The mirror of the revert case above, on the other signature. A save moves live state relative to
// whatever was last APPLIED, so a signature still naming those older bytes made an operator's editor
// undo back to them look like a re-apply of state already live: silently dropped, with memory holding
// the saved state and the file holding the reverted one.
test('reverting to bytes that were applied before a save still reloads', async () => {
  await withStoreAsync({ projects: [] }, async (store, p) => {
    const reloads = [];
    const stop = store.watchForChanges((cfg) => { reloads.push(cfg); });
    try {
      const handEdited = JSON.stringify({
        projects: [{ id: 'hand', name: 'h', path: 'C:/h' }], port: 4100,
      }, null, 2);
      fs.writeFileSync(p, handEdited, 'utf8');
      await waitFor(() => reloads.length > 0, 'the hand-edit never reloaded');

      // A dashboard settings save now writes something else and moves live state with it.
      store.save((cfg) => { cfg.port = 4200; });
      await sleep(1200);
      assert.equal(reloads.length, 1, 'the save itself is still suppressed');

      // Editor undo: back to exactly the bytes that were applied before that save.
      fs.writeFileSync(p, handEdited, 'utf8');
      await waitFor(() => reloads.length > 1, 'the revert was swallowed as a stale applied-signature');
      assert.equal(reloads[reloads.length - 1].port, 4100, 'the reverted content is what was applied');
    } finally {
      stop();
    }
  });
});

// config.json holds the telegram bot token and the PostHog API key. Seeded and saved with no mode, it
// inherited the umask (0644 on a typical Linux box), so every account on a shared host could read those
// credentials. The modes are advisory on Windows, hence the gate.
test('a saved config.json, and its backup, are owner-only', { skip: process.platform === 'win32' }, async () => {
  const { CONFIG_FILE_MODE } = require('../server/config-store');
  await withStoreAsync(richConfig(), async (store, p) => {
    fs.chmodSync(p, 0o644); // as an older Glissa (or an operator's editor) would have left it
    assert.ok(store.save((cfg) => { cfg.port = 4999; }), 'the save succeeded');

    assert.equal(fs.statSync(p).mode & 0o777, CONFIG_FILE_MODE, 'the save repairs a world-readable config');
    assert.equal(fs.statSync(`${p}.bak`).mode & 0o777, CONFIG_FILE_MODE, 'the backup carries the same bytes, so the same mode');
    assert.equal(fs.statSync(`${p}.boot.bak`).mode & 0o777, CONFIG_FILE_MODE, 'and so does the boot backup');
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).port, 4999, 'and the content still landed');
  });
});
