'use strict';

// Control-WS dispatch for the update-settings usage extension: validates the optional nested usage
// object (server/control-handlers.js validateUsage), persists a sanitized copy, and echoes the result
// via settings-updated. Same fake-controlWss harness as control-settings.test.js, which covers the
// prReview/posthog pair the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const { registerControlHandlers } = require('../server/control-handlers');

function fakeConfigStore(cfg) {
  return {
    save: (fn) => { fn(cfg); return cfg; },
    isUnchosenLaunchDefault: () => false,
    getSettings: () => ({
      usage: cfg.usage || null,
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
  sent.length = 0;
  return { send: (msg) => messageHandler(JSON.stringify(msg)), sent, broadcasts, reloadCalls, cfg };
}

function baseCfg() {
  return { projects: [], teams: [], repoRoots: [] };
}

function sendUsage(usage) {
  const h = harness(baseCfg());
  h.send({ type: 'update-settings', settings: { usage } });
  return h;
}

function errorFrom(h) {
  return h.sent.find((m) => m.type === 'settings-error');
}

// --- happy path ---

test('a full valid usage block persists and echoes in settings-updated', () => {
  const usage = {
    enabled: true,
    fetchPricing: false,
    scanIntervalMinutes: 10,
    retainDays: 30,
    sessionBlockHours: 5,
    costMode: 'calculate',
    extraProjectsDirs: [path.resolve('/extra/claude')],
  };
  const h = sendUsage(usage);

  assert.deepEqual(h.cfg.usage, usage);
  const updated = h.sent.find((m) => m.type === 'settings-updated');
  assert.ok(updated, 'replied settings-updated');
  assert.deepEqual(updated.settings.usage, usage);
  assert.equal(h.reloadCalls.length, 1, 'applySettingsReload invoked once (hot-applies the lane)');
  assert.ok(h.broadcasts.some((m) => m.type === 'settings-updated'), 'broadcast to other clients too');
});

test('a partial usage block persists only the keys it carried', () => {
  const h = sendUsage({ costMode: 'display' });
  assert.deepEqual(h.cfg.usage, { costMode: 'display' });
});

// --- an untouched tab never materializes the block ---

test('a save that omits usage never writes the block', () => {
  const h = harness(baseCfg());
  h.send({ type: 'update-settings', settings: { repoRoots: [] } });
  assert.equal(h.cfg.usage, undefined, 'nothing persisted for a tab that was never opened');
  assert.equal(errorFrom(h), undefined);
});

test('an explicitly null usage is valid and still writes nothing', () => {
  const h = sendUsage(null);
  assert.equal(errorFrom(h), undefined);
  assert.equal(h.cfg.usage, undefined);
});

// --- type rejection: a wrong type is refused, never coerced ---

test('a non-object usage is rejected with settings-error', () => {
  for (const value of ['nope', 42, true, ['a']]) {
    const h = sendUsage(value);
    const err = errorFrom(h);
    assert.ok(err && /usage must be an object/.test(err.message), `rejected ${JSON.stringify(value)}`);
    assert.equal(h.cfg.usage, undefined, 'nothing persisted');
    assert.equal(h.reloadCalls.length, 0, 'no reload on a rejected save');
  }
});

test('a non-boolean enabled or fetchPricing is rejected', () => {
  for (const key of ['enabled', 'fetchPricing']) {
    const h = sendUsage({ [key]: 'yes' });
    const err = errorFrom(h);
    assert.ok(err && new RegExp(`usage.${key} must be a boolean`).test(err.message), `rejected ${key}`);
    assert.equal(h.cfg.usage, undefined);
  }
});

// --- integer ranges ---

test('a non-integer or out-of-range interval/retention/block value is rejected', () => {
  const cases = [
    ['scanIntervalMinutes', 0],
    ['scanIntervalMinutes', 1441],
    ['scanIntervalMinutes', 5.5],
    ['scanIntervalMinutes', '5'],
    ['retainDays', 0],
    ['retainDays', 3651],
    ['sessionBlockHours', 0],
    ['sessionBlockHours', 25],
  ];
  for (const [key, value] of cases) {
    const h = sendUsage({ [key]: value });
    const err = errorFrom(h);
    assert.ok(err?.message.includes(`usage.${key} must be an integer between`), `rejected ${key}=${value}`);
    assert.equal(h.cfg.usage, undefined);
  }
});

test('the range boundaries themselves are accepted', () => {
  const usage = { scanIntervalMinutes: 1, retainDays: 3650, sessionBlockHours: 24 };
  const h = sendUsage(usage);
  assert.equal(errorFrom(h), undefined);
  assert.deepEqual(h.cfg.usage, usage);
});

// --- costMode enum ---

test('an unknown costMode is rejected and the three known ones are accepted', () => {
  const h = sendUsage({ costMode: 'estimate' });
  const err = errorFrom(h);
  assert.ok(err && /usage.costMode must be one of auto, calculate, display/.test(err.message));
  assert.equal(h.cfg.usage, undefined);

  for (const costMode of ['auto', 'calculate', 'display']) {
    const ok = sendUsage({ costMode });
    assert.equal(errorFrom(ok), undefined, `${costMode} accepted`);
    assert.deepEqual(ok.cfg.usage, { costMode });
  }
});

// --- extraProjectsDirs: absolute paths only ---

test('a relative extraProjectsDirs entry is rejected (it would resolve against the server cwd)', () => {
  const h = sendUsage({ extraProjectsDirs: ['some/relative/claude'] });
  const err = errorFrom(h);
  assert.ok(err && /absolute/.test(err.message));
  assert.equal(h.cfg.usage, undefined);
});

test('a non-array, empty-string, or non-string extraProjectsDirs entry is rejected', () => {
  for (const value of ['C:/one', [''], ['   '], [42], [null]]) {
    const h = sendUsage({ extraProjectsDirs: value });
    const err = errorFrom(h);
    assert.ok(err && /extraProjectsDirs/.test(err.message), `rejected ${JSON.stringify(value)}`);
    assert.equal(h.cfg.usage, undefined);
  }
});

test('an empty extraProjectsDirs array is accepted', () => {
  const h = sendUsage({ extraProjectsDirs: [] });
  assert.equal(errorFrom(h), undefined);
  assert.deepEqual(h.cfg.usage, { extraProjectsDirs: [] });
});

test('an absolute extraProjectsDirs entry is trimmed on the way to disk', () => {
  const absolute = path.resolve('/claude-home');
  const h = sendUsage({ extraProjectsDirs: [`  ${absolute}  `] });
  assert.equal(errorFrom(h), undefined);
  assert.deepEqual(h.cfg.usage, { extraProjectsDirs: [absolute] });
});

// --- sanitize drops what the dialog echoes back ---

test('unknown usage keys are dropped rather than persisted', () => {
  const h = sendUsage({ enabled: true, pricingSource: 'snapshot', scanStats: { files: 12 }, dirs: ['C:/x'] });
  assert.deepEqual(h.cfg.usage, { enabled: true }, 'only known keys survive');
});

// --- request-usage-report dispatch ---

test('request-usage-report without a wired lane replies an error, never a silent drop', async () => {
  const h = harness(baseCfg());
  await h.send({ type: 'request-usage-report', requestId: 'r1' });
  const reply = h.sent.find((m) => m.type === 'usage-report');
  assert.ok(reply, 'the requesting socket always gets an answer');
  assert.equal(reply.requestId, 'r1');
  assert.match(reply.error, /not running/);
});

test('request-usage-report passes force through and drops an out-of-range days', async () => {
  const calls = [];
  const controlWss = new EventEmitter();
  const cfg = baseCfg();
  const sent = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: fakeConfigStore(cfg),
    applyConfigReload: () => {},
    applySettingsReload: () => {},
    broadcastControl: () => {},
    requestUsageReport: async (args) => {
      calls.push(args);
      return { type: 'usage-report', requestId: args.requestId, totals: { tokens: 0 } };
    },
  });
  controlWss.emit('connection', ws);

  await messageHandler(JSON.stringify({ type: 'request-usage-report', requestId: 'a', days: 30, force: true }));
  await messageHandler(JSON.stringify({ type: 'request-usage-report', requestId: 'b', days: 99999 }));
  await messageHandler(JSON.stringify({ type: 'request-usage-report', requestId: 'c', days: 'lots', force: 'yes' }));

  assert.deepEqual(calls, [
    { days: 30, force: true, requestId: 'a' },
    { days: undefined, force: false, requestId: 'b' },
    { days: undefined, force: false, requestId: 'c' },
  ]);
  assert.equal(sent.filter((m) => m.type === 'usage-report').length, 3, 'every request is answered');
});

// --- connect replay ---

test('a connecting client gets the live usage-sessions and the cached usage-report', () => {
  const controlWss = new EventEmitter();
  const cfg = baseCfg();
  const sent = [];
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: () => {} };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: fakeConfigStore(cfg),
    applyConfigReload: () => {},
    applySettingsReload: () => {},
    broadcastControl: () => {},
    getUsageSessions: () => ({ type: 'usage-sessions', ts: 1, pricingSource: 'snapshot', sessions: [] }),
    getUsageReport: () => ({ type: 'usage-report', requestId: null, totals: { tokens: 7 } }),
  });
  controlWss.emit('connection', ws);

  assert.ok(sent.some((m) => m.type === 'usage-sessions'));
  assert.ok(sent.some((m) => m.type === 'usage-report' && m.totals.tokens === 7));
});

test('a caller that wires no usage accessors replays no usage messages', () => {
  const controlWss = new EventEmitter();
  const cfg = baseCfg();
  const sent = [];
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: () => {} };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: fakeConfigStore(cfg),
    applyConfigReload: () => {},
    applySettingsReload: () => {},
    broadcastControl: () => {},
  });
  controlWss.emit('connection', ws);

  assert.equal(sent.filter((m) => m.type.startsWith('usage-')).length, 0, 'an older caller sees nothing new on the wire');
  assert.ok(sent.some((m) => m.type === 'snapshot'), 'the pre-existing connect frames still go out');
});
