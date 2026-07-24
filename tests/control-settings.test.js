'use strict';

// Control-WS dispatch for the update-settings PR-review/telegram extension: validates the optional
// nested prReview/telegram objects (server/control-handlers.js validatePrReview/validateTelegram),
// persists a sanitized copy (unknown keys like a stray projectChoices echo are dropped), and echoes
// the result via settings-updated. Mirrors the fake-controlWss harness used by control-resume.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');

function fakeConfigStore(cfg) {
  return {
    save: (fn) => { fn(cfg); return cfg; },
    getSettings: () => ({
      prReview: cfg.prReview || null,
      telegram: cfg.telegram || null,
      projectChoices: (cfg.projects || []).map((p) => ({ id: p.id, name: p.name })),
      repoRoots: cfg.repoRoots || [],
    }),
  };
}

function harness(cfg) {
  const controlWss = new EventEmitter();
  const sent = [];
  const broadcasts = [];
  const reloadCalls = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: fakeConfigStore(cfg),
    applyConfigReload: () => {},
    applySettingsReload: (c) => reloadCalls.push(c),
    broadcastControl: (m) => broadcasts.push(m),
  });
  controlWss.emit('connection', ws);
  sent.length = 0; // drop the initial snapshot
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent, broadcasts, reloadCalls, cfg };
}

test('a valid prReview+telegram payload persists and echoes in settings-updated', () => {
  const h = harness({ projects: [{ id: 'p1', name: 'proj-one', path: 'C:/p1' }], teams: [] });

  h.send({
    type: 'update-settings',
    settings: {
      prReview: { enabled: true, projects: ['p1'], intervalMinutes: 10, mergeMethod: 'squash', maxConcurrentReviews: 2, reviewTimeoutSeconds: 600 },
      telegram: { botToken: 'tok', chatId: '123' },
    },
  });

  assert.deepEqual(h.cfg.prReview, { enabled: true, projects: ['p1'], intervalMinutes: 10, mergeMethod: 'squash', maxConcurrentReviews: 2, reviewTimeoutSeconds: 600 });
  assert.deepEqual(h.cfg.telegram, { botToken: 'tok', chatId: '123' });

  const updated = h.sent.find((m) => m.type === 'settings-updated');
  assert.ok(updated, 'replied settings-updated');
  assert.deepEqual(updated.settings.prReview, h.cfg.prReview);
  assert.deepEqual(updated.settings.telegram, h.cfg.telegram);

  assert.equal(h.reloadCalls.length, 1, 'applySettingsReload invoked once (hot-applies the poller)');
  assert.ok(h.broadcasts.some((m) => m.type === 'settings-updated'), 'broadcast to other clients too');
});

test('an invalid mergeMethod is rejected with settings-error and nothing is persisted', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { prReview: { mergeMethod: 'fast-forward' } } });

  const err = h.sent.find((m) => m.type === 'settings-error');
  assert.ok(err && /mergeMethod/.test(err.message));
  assert.equal(h.cfg.prReview, undefined, 'nothing persisted');
  assert.equal(h.reloadCalls.length, 0, 'no reload on a rejected save');
});

test('non-array prReview.projects is rejected with settings-error', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { prReview: { projects: 'p1' } } });

  const err = h.sent.find((m) => m.type === 'settings-error');
  assert.ok(err && /projects/.test(err.message));
  assert.equal(h.cfg.prReview, undefined);
});

test('a non-boolean prReview.enabled is rejected with settings-error', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { prReview: { enabled: 'yes' } } });

  const err = h.sent.find((m) => m.type === 'settings-error');
  assert.ok(err && /enabled/.test(err.message));
  assert.equal(h.cfg.prReview, undefined);
});

test('a non-positive prReview numeric field is rejected with settings-error', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { prReview: { intervalMinutes: 0 } } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /intervalMinutes/.test(m.message)));
});

test('a non-object telegram is rejected with settings-error', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { telegram: 'nope' } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /telegram/.test(m.message)));
});

test('a stray projectChoices field in the payload is never persisted', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({
    type: 'update-settings',
    settings: { prReview: { enabled: false }, projectChoices: [{ id: 'x', name: 'y' }] },
  });

  assert.deepEqual(h.cfg.prReview, { enabled: false });
  assert.equal(h.cfg.projectChoices, undefined, 'projectChoices is derived read-only, never written to cfg');
});

test('empty telegram strings persist as-is (means unset), key is not deleted', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { telegram: { botToken: '', chatId: '' } } });

  assert.deepEqual(h.cfg.telegram, { botToken: '', chatId: '' });
});
