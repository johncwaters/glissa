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
  createConfigStore, ensureProjectIds, DEFAULT_CONFIG,
} = require('../server/config-store');

function writeTmpConfig(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-cfgstore-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return { dir, p };
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
    store.applySettings({ cursorBlink: 1, debugMode: 0, autoRecoverSeconds: 7, editorCommand: 123 });
    assert.equal(store.config.cursorBlink, true, 'boolean coerced');
    assert.equal(store.config.debugMode, false, 'falsy boolean coerced');
    assert.equal(store.config.autoRecoverSeconds, 7, 'timeout applied');
    assert.equal(store.config.editorCommand, '123', 'string coerced');
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

test('watchForChanges returns a closer that releases the fs.watch handle', () => {
  withStore({ projects: [] }, (store) => {
    const stop = store.watchForChanges(() => {});
    assert.equal(typeof stop, 'function', 'returns a closer');
    assert.doesNotThrow(stop);
    assert.doesNotThrow(stop, 'idempotent');
  });
});
