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

// Runs fn with GLISSA_CONFIG pointed at a temp config, then restores env + disk.
function withStore(cfg, fn) {
  const { dir, p } = writeTmpConfig(cfg);
  const prev = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = p;
  try {
    return fn(createConfigStore(), p);
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

test('applySettings coerces booleans and strings and applies timeouts', () => {
  withStore({ projects: [] }, (store) => {
    store.applySettings({ cursorBlink: 1, debugMode: 0, autoRecoverSeconds: 7, editorCommand: 123 });
    assert.equal(store.config.cursorBlink, true, 'boolean coerced');
    assert.equal(store.config.debugMode, false, 'falsy boolean coerced');
    assert.equal(store.config.autoRecoverSeconds, 7, 'timeout applied');
    assert.equal(store.config.editorCommand, '123', 'string coerced');
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
