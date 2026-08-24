'use strict';

// Control-WS dispatch for the Mill tab's one write: set-project-packs delivers (or stops delivering) ONE
// context pack to one project. What is pinned here is that a REFUSAL changes nothing, that the delta is
// applied to the list read INSIDE the write rather than to whatever the client was rendered from, that a
// newly delivered pack is BUILT before the reload that recreates the session, and that the requester is
// answered before the reload can throw. Mirrors the fake-controlWss harness used by control-resume.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');

const SPECS = ['company-context', 'house-rules', 'a', 'b', 'c', 'd', 'e'];

function harness(cfg, { specs = SPECS, onReload = null, ensurePacksBuilt } = {}) {
  const controlWss = new EventEmitter();
  const sent = [];
  const broadcasts = [];
  const saveCalls = [];
  const reloads = [];
  // One ordered log, because the invariant under test is an ORDER: the build has to land before the
  // reload that recreates the session which resolves its packs at spawn.
  const events = [];
  const builds = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: {
      save: (fn) => { saveCalls.push(1); fn(cfg); return cfg; },
      getSettings: () => ({}),
    },
    applyConfigReload: (fresh) => {
      events.push('reload');
      reloads.push(fresh);
      if (onReload) onReload();
    },
    broadcastControl: (m) => { if (m.type === 'project-packs-updated') events.push('broadcast'); broadcasts.push(m); },
    listPackNames: async () => specs,
    ensurePacksBuilt: ensurePacksBuilt || (async (names) => { events.push('build'); builds.push(...names); }),
  });
  controlWss.emit('connection', ws);
  sent.length = 0;
  return {
    send: (msg) => messageHandler(JSON.stringify(msg)),
    sent, broadcasts, saveCalls, reloads, events, builds,
    onReply: () => { events.push('reply'); },
  };
}

function project(overrides = {}) {
  return { id: 'p1', name: 'glissa', path: 'C:/repo', ...overrides };
}

function resultOf(h) {
  return h.sent.find((m) => m.type === 'set-project-packs-result');
}

test('delivering a pack persists it on the project record and reloads like a hand edit', async () => {
  const cfg = { projects: [project()] };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', requestId: 'r1', projectId: 'p1', pack: 'company-context', deliver: true });

  assert.deepEqual(cfg.projects[0].packs, ['company-context']);
  assert.equal(h.reloads.length, 1, 'the same reload a config.json edit takes');
  const result = resultOf(h);
  assert.equal(result.ok, true);
  assert.equal(result.requestId, 'r1');
  assert.deepEqual(result.packs, ['company-context']);
  const broadcast = h.broadcasts.find((m) => m.type === 'project-packs-updated');
  assert.deepEqual(broadcast.packs, ['company-context']);
});

// MAJOR: consumer gating guarantees a newly delivered pack has NEVER been built, and a session resolves
// its packs at spawn. A build that waits for the reload arrives after the spawn it exists for.
test('a newly delivered pack is built BEFORE the reload that recreates the session', async () => {
  const cfg = { projects: [project()] };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: true });

  assert.deepEqual(h.builds, ['company-context']);
  assert.ok(h.events.indexOf('build') < h.events.indexOf('reload'),
    `build must precede reload, got ${h.events.join(' -> ')}`);
});

test('the build is awaited, so a slow build still lands before the reload', async () => {
  const cfg = { projects: [project()] };
  const order = [];
  const h = harness(cfg, {
    onReload: () => order.push('reload'),
    ensurePacksBuilt: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('build');
    },
  });

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: true });

  assert.deepEqual(order, ['build', 'reload']);
});

test('a removal builds nothing: there is no new delivery to prepare', async () => {
  const cfg = { projects: [project({ packs: ['company-context'] })] };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: false });

  assert.equal('packs' in cfg.projects[0], false, 'an emptied list removes the key');
  assert.deepEqual(h.builds, []);
});

// The whole reason the wire format is a delta: each client was rendered from its own snapshot.
test('the delta is applied to the list read inside the write, not to a client snapshot', async () => {
  const cfg = { projects: [project({ packs: ['house-rules'] })] };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: true });

  assert.deepEqual(cfg.projects[0].packs, ['house-rules', 'company-context'],
    'a concurrent edit this client never saw survives the toggle');
});

test('a project already naming a deleted spec can still be edited', async () => {
  const cfg = { projects: [project({ packs: ['ghost'] })] };
  const h = harness(cfg);

  // Only the name being ADDED is checked against the specs, so the ghost does not freeze the list.
  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: true });
  assert.deepEqual(cfg.projects[0].packs, ['ghost', 'company-context']);
  assert.equal(resultOf(h).ok, true);

  h.sent.length = 0;
  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'ghost', deliver: false });
  assert.deepEqual(cfg.projects[0].packs, ['company-context'], 'and the ghost itself can be removed');
  assert.equal(resultOf(h).ok, true);
});

test('delivering a pack twice is idempotent rather than a duplicate entry', async () => {
  const cfg = { projects: [project({ packs: ['company-context'] })] };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: true });

  assert.deepEqual(cfg.projects[0].packs, ['company-context']);
  assert.equal(resultOf(h).ok, true);
});

// Delivery is addressed per PROJECT, and a project is a path: "glissa" and "glissa (2)" are two cards
// on one checkout, and a tick on either has to move both or the tab offers a delivery it cannot keep.
test('a delta on one card moves every card sharing that checkout', async () => {
  const cfg = { projects: [project(), project({ id: 'p2', name: 'glissa (2)' }), project({ id: 'p3', name: 'other', path: 'C:/other' })] };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', projectId: 'p2', pack: 'company-context', deliver: true });

  assert.deepEqual(cfg.projects[0].packs, ['company-context']);
  assert.deepEqual(cfg.projects[1].packs, ['company-context']);
  assert.equal('packs' in cfg.projects[2], false, 'another checkout is untouched');
  assert.deepEqual(resultOf(h).packs, ['company-context'], 'the addressed record is what the reply reports');
});

test('a removal on one card clears every card sharing that checkout', async () => {
  const cfg = {
    projects: [
      project({ packs: ['company-context', 'house-rules'] }),
      project({ id: 'p2', name: 'glissa (2)', packs: ['company-context'] }),
    ],
  };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: false });

  assert.deepEqual(cfg.projects[0].packs, ['house-rules']);
  assert.equal('packs' in cfg.projects[1], false, 'an emptied list removes the key on the sibling too');
});

test('a sibling at the cap refuses the whole delta, leaving every record alone', async () => {
  const cfg = {
    projects: [
      project({ packs: ['a', 'b'] }),
      project({ id: 'p2', name: 'glissa (2)', packs: ['a', 'b', 'c', 'd'] }),
    ],
  };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'e', deliver: true });

  assert.deepEqual(cfg.projects[0].packs, ['a', 'b'], 'the addressed record is not written half way');
  assert.deepEqual(cfg.projects[1].packs, ['a', 'b', 'c', 'd']);
  assert.equal(h.reloads.length, 0);
  assert.match(resultOf(h).error, /at most 4 packs/);
});

test('a record with no path is alone: nothing marks another record as its sibling', async () => {
  const cfg = { projects: [project({ path: undefined }), project({ id: 'p2', name: 'other', path: undefined })] };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: true });

  assert.deepEqual(cfg.projects[0].packs, ['company-context']);
  assert.equal('packs' in cfg.projects[1], false);
});

test('an unknown project changes nothing', async () => {
  const cfg = { projects: [project()] };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', projectId: 'nope', pack: 'company-context', deliver: true });

  assert.equal(h.saveCalls.length, 0);
  assert.equal(h.reloads.length, 0);
  assert.deepEqual(h.broadcasts, []);
  assert.match(resultOf(h).error, /Unknown project/);
});

test('a project that vanished between the check and the write is refused, never reported ok', async () => {
  const cfg = { projects: [project()] };
  const controlWss = new EventEmitter();
  const sent = [];
  const reloads = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: {
      // The fresh read no longer holds the project: the mutator's verdict has to reach the requester.
      save: (fn) => { const fresh = { projects: [] }; fn(fresh); return fresh; },
      getSettings: () => ({}),
    },
    applyConfigReload: (fresh) => reloads.push(fresh),
    broadcastControl: () => {},
    listPackNames: async () => SPECS,
  });
  controlWss.emit('connection', ws);
  sent.length = 0;

  await messageHandler(JSON.stringify({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: true }));

  assert.deepEqual(reloads, []);
  const result = sent.find((m) => m.type === 'set-project-packs-result');
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown project/);
});

test('a malformed pack name or a non-boolean deliver changes nothing', async () => {
  const cfg = { projects: [project()] };
  const h = harness(cfg);

  for (const msg of [
    { pack: '../escape', deliver: true },
    { pack: '', deliver: true },
    { pack: 42, deliver: true },
    { pack: 'company-context', deliver: 'yes' },
    { pack: 'company-context' },
  ]) {
    await h.send({ type: 'set-project-packs', projectId: 'p1', ...msg });
  }

  assert.equal(h.saveCalls.length, 0);
  assert.equal('packs' in cfg.projects[0], false);
});

test('a pack name no spec file defines is refused before anything is written', async () => {
  const cfg = { projects: [project()] };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'ghost', deliver: true });

  assert.equal(h.saveCalls.length, 0);
  assert.equal(h.reloads.length, 0);
  assert.deepEqual(h.builds, []);
  assert.match(resultOf(h).error, /No pack spec named "ghost"/);
});

test('a delivery past the per-project cap is refused and the record is left alone', async () => {
  const cfg = { projects: [project({ packs: ['a', 'b', 'c', 'd'] })] };
  const h = harness(cfg);

  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'e', deliver: true });

  assert.deepEqual(cfg.projects[0].packs, ['a', 'b', 'c', 'd'], 'nothing was ticked away to make room');
  assert.equal(h.reloads.length, 0);
  assert.match(resultOf(h).error, /at most 4 packs/);
});

test('with no spec listing available a delivery is refused, never guessed at', async () => {
  const cfg = { projects: [project()] };
  const controlWss = new EventEmitter();
  const sent = [];
  const saveCalls = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: { save: (fn) => { saveCalls.push(1); fn(cfg); return cfg; }, getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: () => {},
  });
  controlWss.emit('connection', ws);
  sent.length = 0;

  await messageHandler(JSON.stringify({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: true }));

  assert.equal(saveCalls.length, 0);
  assert.match(sent.find((m) => m.type === 'set-project-packs-result').error, /not running/);
});

test('a failed config write is reported and never reloaded', async () => {
  const cfg = { projects: [project()] };
  const controlWss = new EventEmitter();
  const sent = [];
  const reloads = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: { save: () => null, getSettings: () => ({}) },
    applyConfigReload: (fresh) => reloads.push(fresh),
    broadcastControl: () => {},
    listPackNames: async () => SPECS,
  });
  controlWss.emit('connection', ws);
  sent.length = 0;

  await messageHandler(JSON.stringify({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: true }));

  assert.deepEqual(reloads, []);
  assert.equal(sent.find((m) => m.type === 'set-project-packs-result').ok, false);
});

// The write has already landed by then, so a throw downstream must not cost the requester its frame and
// leave the checkbox disabled forever.
test('the requester is answered before the reload, so a throwing reload cannot strand it', async () => {
  const cfg = { projects: [project()] };
  const h = harness(cfg, { onReload: () => { throw new Error('reload exploded'); } });

  // The dispatcher swallows an async handler's rejection (it must not become an unhandledRejection),
  // so what matters is that the requester already has its frame by the time the reload blows up.
  await h.send({ type: 'set-project-packs', projectId: 'p1', pack: 'company-context', deliver: true });

  const result = resultOf(h);
  assert.equal(result.ok, true, 'the persisted change was reported before the reload ran');
  assert.ok(h.broadcasts.some((m) => m.type === 'project-packs-updated'));
});
