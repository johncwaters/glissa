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
  createConfigStore, ensureProjectIds, validateConfig, loadConfigFile, DEFAULT_CONFIG,
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
    assert.match(loaded.message, /Could not parse/);
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

test('getSettings: prReview/telegram are null when absent, echoed when set; projectChoices derives from projects', () => {
  withStore({ projects: [{ id: 'p1', name: 'proj-one', path: 'C:/p1' }] }, (store) => {
    const s = store.getSettings();
    assert.equal(s.prReview, null);
    assert.equal(s.telegram, null);
    assert.deepEqual(s.projectChoices, [{ id: 'p1', name: 'proj-one' }]);

    store.config.prReview = { enabled: true, projects: ['p1'] };
    store.config.telegram = { botToken: 'tok', chatId: '123' };
    const s2 = store.getSettings();
    assert.deepEqual(s2.prReview, { enabled: true, projects: ['p1'] });
    assert.deepEqual(s2.telegram, { botToken: 'tok', chatId: '123' });
  });
});

test('applySettings passes prReview/telegram through only when present on the incoming config', () => {
  withStore({ projects: [] }, (store) => {
    store.applySettings({ cursorBlink: true });
    assert.equal(store.config.prReview, undefined, 'absent on the incoming config leaves it untouched');
    assert.equal(store.config.telegram, undefined);

    store.applySettings({ prReview: { enabled: true }, telegram: { botToken: 'x', chatId: 'y' } });
    assert.deepEqual(store.config.prReview, { enabled: true });
    assert.deepEqual(store.config.telegram, { botToken: 'x', chatId: 'y' });
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
