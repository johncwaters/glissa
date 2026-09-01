'use strict';

// Control-WS dispatch for the Hooks tab. Pinned: the report carries the stored records, the catalog,
// Glissa's own hooks and the project list; a save mints the id, validates through the core, writes via
// configStore.save and reloads like a hand edit; an edit must name a record we hold; a delete down to
// none removes the key; and every refusal changes nothing. Mirrors the control-project-packs harness.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');
const { HOOK_EVENTS } = require('../detection/settings-injector.ts');
const { MAX_TIMEOUT_SEC } = require('../session/core/user-hooks-core');

function harness(cfg, { saveFails = false, rtkPath = '/usr/bin/rtk' } = {}) {
  const controlWss = new EventEmitter();
  const sent = [];
  const broadcasts = [];
  const reloads = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: {
      save: (fn) => { if (saveFails) return null; fn(cfg); return cfg; },
      getSettings: () => ({}),
    },
    applyConfigReload: (fresh) => { reloads.push(fresh); },
    broadcastControl: (m) => broadcasts.push(m),
    resolveRtkPath: () => rtkPath,
  });
  controlWss.emit('connection', ws);
  sent.length = 0;
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent, broadcasts, reloads };
}

const record = (overrides = {}) => ({ id: 'h1', name: 'Lint', event: 'PostToolUse', matcher: 'Edit', type: 'command', command: 'npm run lint', enabled: true, ...overrides });

test('request-hooks-report answers the stored records, the catalog, the built-in hooks and the projects', async () => {
  const cfg = { projects: [{ id: 'p1', name: 'glissa', path: '/r' }, { id: 'p2', name: 'codex', path: '/c', agent: 'codex' }], hooks: [record(), { id: 'broken' }], rtk: true };
  const h = harness(cfg);
  await h.send({ type: 'request-hooks-report', requestId: 'r1' });
  const report = h.sent.find((m) => m.type === 'hooks-report');
  assert.equal(report.requestId, 'r1');
  assert.deepEqual(report.hooks, [record()]);
  assert.ok(report.events.some((entry) => entry.name === 'PreToolUse'));
  assert.deepEqual(report.projects, [{ id: 'p1', name: 'glissa', agent: 'claude-code' }, { id: 'p2', name: 'codex', agent: 'codex' }]);
  const builtinEvents = report.builtin.map((row) => row.event);
  for (const event of HOOK_EVENTS) assert.ok(builtinEvents.includes(event), event);
  assert.ok(report.builtin.some((row) => row.event === 'PreToolUse' && row.matcher === 'Bash'), 'rtk entry when config.rtk');
  assert.ok(report.builtin.some((row) => row.event === 'PostToolUse'), 'wakeup tracking entry');
  assert.ok(report.builtin.some((row) => row.event === 'PostToolUse' && row.matcher === 'Read' && row.purpose === 'Pack read tracking'));
  assert.deepEqual(report.limits, { maxTimeoutSec: MAX_TIMEOUT_SEC });
});

// The injector writes the rtk entry only when a real binary resolved, so a report listing it on
// config.rtk alone told the operator a hook was firing that no settings file carries.
test('the rtk row is listed on the resolved binary, not on config.rtk alone', async () => {
  const h = harness({ projects: [], rtk: true }, { rtkPath: null });
  await h.send({ type: 'request-hooks-report', requestId: 'r1' });
  const report = h.sent.find((m) => m.type === 'hooks-report');
  assert.deepEqual(report.builtin.filter((row) => row.purpose.includes('rtk')), []);
});

// A stored record this build cannot normalize (an event a newer Claude Code added) is not ours to
// erase: an unrelated save or delete must leave it exactly where it was.
test('a stored record the core cannot read survives an unrelated save and an unrelated delete', async () => {
  const future = { id: 'future', name: 'f', event: 'NotYetKnown', type: 'command', command: 'x', enabled: true };
  const cfg = { projects: [], hooks: [future, record()] };
  const h = harness(cfg);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: record({ name: 'Lint 2' }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result').ok, true);
  assert.deepEqual(cfg.hooks.map((hook) => hook.id), ['future', 'h1']);
  assert.deepEqual(cfg.hooks[0], future);
  assert.equal(cfg.hooks[1].name, 'Lint 2');

  h.sent.length = 0;
  await h.send({ type: 'delete-hook', requestId: 'r2', id: 'h1' });
  assert.equal(h.sent.find((m) => m.type === 'delete-hook-result').ok, true);
  assert.deepEqual(cfg.hooks, [future]);
});

test('save-hook mints an id for a new hook, persists it, reloads and broadcasts', async () => {
  const cfg = { projects: [{ id: 'p1', name: 'glissa', path: '/r' }] };
  const h = harness(cfg);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: { name: ' Notify ', event: 'Stop', type: 'http', url: 'http://127.0.0.1:1/x', projects: ['p1'] } });
  const result = h.sent.find((m) => m.type === 'save-hook-result');
  assert.equal(result.ok, true);
  assert.equal(typeof result.hook.id, 'string');
  assert.equal(result.hook.name, 'Notify');
  assert.deepEqual(cfg.hooks, [result.hook]);
  assert.equal(h.reloads.length, 1);
  assert.deepEqual(h.broadcasts, [{ type: 'hooks-updated', count: 1 }]);
});

test('save-hook with an id replaces that record and refuses an id it does not hold', async () => {
  const cfg = { projects: [], hooks: [record()] };
  const h = harness(cfg);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: record({ enabled: false }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result').ok, true);
  assert.equal(cfg.hooks.length, 1);
  assert.equal(cfg.hooks[0].enabled, false);

  h.sent.length = 0;
  await h.send({ type: 'save-hook', requestId: 'r2', hook: record({ id: 'nope' }) });
  const refused = h.sent.find((m) => m.type === 'save-hook-result');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'Unknown hook');
  assert.equal(cfg.hooks.length, 1);
  assert.equal(h.reloads.length, 1);
});

test('save-hook refuses an invalid record with the core message and writes nothing', async () => {
  const cfg = { projects: [] };
  const h = harness(cfg);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: { name: 'x', event: 'Stop', matcher: 'y', type: 'command', command: 'z' } });
  const result = h.sent.find((m) => m.type === 'save-hook-result');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Stop takes no matcher');
  assert.equal('hooks' in cfg, false);
  assert.equal(h.reloads.length, 0);
  assert.equal(h.broadcasts.length, 0);
});

test('save-hook refuses a project the config does not hold', async () => {
  const cfg = { projects: [{ id: 'p1', name: 'glissa', path: '/r' }] };
  const h = harness(cfg);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: record({ id: undefined, projects: ['p9'] }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result').error, 'Unknown project p9');
});

// A row toggle sends the whole record back. Refusing the ids the record already holds made a hook
// scoped to a removed project untogglable, and stripping them client side would have quietly turned it
// global, so an EDIT keeps the dead scope (inert: hooksForProject only ever matches a live id).
test('an edit keeps a scope naming a project that left config; a new hook still may not name one', async () => {
  const cfg = { projects: [{ id: 'p1', name: 'glissa', path: '/r' }], hooks: [record({ projects: ['gone'] })] };
  const h = harness(cfg);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: record({ projects: ['gone'], enabled: false }) });
  const result = h.sent.find((m) => m.type === 'save-hook-result');
  assert.equal(result.ok, true);
  assert.deepEqual(result.hook.projects, ['gone']);
  assert.deepEqual(cfg.hooks[0].projects, ['gone']);
  assert.equal(cfg.hooks[0].enabled, false);

  // Only the dead ids that record already carried: an edit may not introduce another one.
  h.sent.length = 0;
  await h.send({ type: 'save-hook', requestId: 'r2', hook: record({ projects: ['gone', 'alsoGone'] }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result').error, 'Unknown project alsoGone');

  h.sent.length = 0;
  await h.send({ type: 'save-hook', requestId: 'r3', hook: record({ id: undefined, projects: ['gone'] }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result').error, 'Unknown project gone');
});

test('a failed config write is reported, not swallowed', async () => {
  const cfg = { projects: [] };
  const h = harness(cfg, { saveFails: true });
  await h.send({ type: 'save-hook', requestId: 'r1', hook: record({ id: undefined }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result').error, 'Could not write config.json');
});

test('delete-hook removes the record, drops the key when none remain, and refuses an unknown id', async () => {
  const cfg = { projects: [], hooks: [record(), record({ id: 'h2' })] };
  const h = harness(cfg);
  await h.send({ type: 'delete-hook', requestId: 'r1', id: 'h1' });
  assert.deepEqual(h.sent.find((m) => m.type === 'delete-hook-result'), { type: 'delete-hook-result', requestId: 'r1', ok: true, error: null, id: 'h1' });
  assert.deepEqual(cfg.hooks.map((hook) => hook.id), ['h2']);

  h.sent.length = 0;
  await h.send({ type: 'delete-hook', requestId: 'r2', id: 'h2' });
  assert.equal('hooks' in cfg, false);
  assert.deepEqual(h.broadcasts.at(-1), { type: 'hooks-updated', count: 0 });

  h.sent.length = 0;
  await h.send({ type: 'delete-hook', requestId: 'r3', id: 'h2' });
  assert.equal(h.sent.find((m) => m.type === 'delete-hook-result').error, 'Unknown hook');
  assert.equal(h.reloads.length, 2);
});

test('a malformed hooks request receives its typed error reply', async () => {
  const h = harness({ projects: [] });
  await h.send({ type: 'save-hook', requestId: 'r1', hook: 'nope' });
  const result = h.sent.find((m) => m.type === 'save-hook-result');
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  h.sent.length = 0;
  await h.send({ type: 'delete-hook', requestId: 'r2' });
  assert.equal(h.sent.find((m) => m.type === 'delete-hook-result').ok, false);
});

test('delete-hook removes a stored record this build cannot read, so a hand edit is never the only way out', async () => {
  const cfg = { projects: [], hooks: [record(), { id: 'future', name: 'f', event: 'NotYetKnown', type: 'command', command: 'x', enabled: true }] };
  const h = harness(cfg);
  await h.send({ type: 'delete-hook', requestId: 'r1', id: 'future' });
  assert.equal(h.sent.find((m) => m.type === 'delete-hook-result').ok, true);
  assert.deepEqual(cfg.hooks.map((hook) => hook.id), ['h1']);
});
