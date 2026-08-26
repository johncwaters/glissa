'use strict';

// Control-WS dispatch for the update-settings PR-review/telegram extension: validates the optional
// nested prReview/telegram objects (server/control-handlers.js validatePrReview/validateTelegram),
// persists a sanitized copy (unknown keys like a stray projectChoices echo are dropped), and echoes
// the result via settings-updated. Mirrors the fake-controlWss harness used by control-resume.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerControlHandlers } = require('../server/control-handlers');
const { createConfigStore } = require('../server/config-store');

function fakeConfigStore(cfg) {
  return {
    save: (fn) => { fn(cfg); return cfg; },
    isUnchosenLaunchDefault: () => false, // no launch-default overlay in these fixtures
    getSettings: () => ({
      prReview: cfg.prReview || null,
      branchGc: cfg.branchGc || null,
      visions: cfg.visions || null,
      posthog: cfg.posthog || null,
      telegram: cfg.telegram || null,
      projectChoices: (cfg.projects || []).map((p) => ({ id: p.id, name: p.name })),
      repoRoots: cfg.repoRoots || [],
    }),
  };
}

function harness(cfg, store = fakeConfigStore(cfg)) {
  const controlWss = new EventEmitter();
  const sent = [];
  const broadcasts = [];
  const reloadCalls = [];
  let messageHandler = null;
  const ws = { send: (s) => sent.push(JSON.parse(s)), on: (ev, h) => { if (ev === 'message') messageHandler = h; } };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: cfg,
    configStore: store,
    applyConfigReload: () => {},
    applySettingsReload: (c) => { reloadCalls.push(c); if (store.applySettings) store.applySettings(c); },
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

test('a stray projectChoices field is rejected by name without a partial write', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({
    type: 'update-settings',
    settings: { prReview: { enabled: false }, projectChoices: [{ id: 'x', name: 'y' }] },
  });

  assert.equal(h.cfg.prReview, undefined);
  assert.equal(h.cfg.projectChoices, undefined, 'projectChoices is derived read-only, never written to cfg');
  assert.match(h.sent.find((message) => message.type === 'settings-error').message, /projectChoices/);
});

test('worktree conflict switches remain settable while withheld from settings', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({
    type: 'update-settings',
    settings: { worktreeAutoRebase: false, worktreeRerere: false },
  });

  assert.equal(h.cfg.worktreeAutoRebase, false);
  assert.equal(h.cfg.worktreeRerere, false);
  assert.equal(h.sent.some((message) => message.type === 'settings-error'), false);
});

test('a valid branchGc payload is sanitized, persisted, and echoed', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({
    type: 'update-settings',
    settings: { branchGc: { enabled: true, staleDays: 21, intervalMs: 3600000, unknown: 'drop' } },
  });

  assert.deepEqual(h.cfg.branchGc, { enabled: true, staleDays: 21, intervalMs: 3600000 });
  const updated = h.sent.find((message) => message.type === 'settings-updated');
  assert.deepEqual(updated.settings.branchGc, h.cfg.branchGc);
});

test('branchGc rejects non-boolean enablement and non-positive numeric fields', () => {
  for (const branchGc of [{ enabled: 'yes' }, { staleDays: 0 }, { intervalMs: -1 }]) {
    const h = harness({ projects: [], teams: [] });
    h.send({ type: 'update-settings', settings: { branchGc } });
    assert.ok(h.sent.some((message) => message.type === 'settings-error'));
    assert.equal(h.cfg.branchGc, undefined);
  }
});

test('a settings save that omits branchGc preserves its existing opt-out', () => {
  const h = harness({ branchGc: { enabled: false }, projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { cursorBlink: true } });

  assert.deepEqual(h.cfg.branchGc, { enabled: false });
});

test('empty telegram strings persist as-is (means unset), key is not deleted', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { telegram: { botToken: '', chatId: '' } } });

  assert.deepEqual(h.cfg.telegram, { botToken: '', chatId: '' });
});

test('a telegram update without the bot token leaves the stored token intact', () => {
  const h = harness({ telegram: { botToken: 'stored-tok', chatId: '123' }, projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { telegram: { chatId: '456' } } });

  assert.deepEqual(h.cfg.telegram, { botToken: 'stored-tok', chatId: '456' });
});

test('a telegram update carrying a new bot token replaces the stored one', () => {
  const h = harness({ telegram: { botToken: 'stored-tok', chatId: '123' }, projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { telegram: { botToken: 'fresh-tok', chatId: '123' } } });

  assert.deepEqual(h.cfg.telegram, { botToken: 'fresh-tok', chatId: '123' });
});

test('an explicitly emptied bot token clears the stored one', () => {
  const h = harness({ telegram: { botToken: 'stored-tok', chatId: '123' }, projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { telegram: { botToken: '', chatId: '123' } } });

  assert.deepEqual(h.cfg.telegram, { botToken: '', chatId: '123' });
});

test('a valid visions payload persists and echoes in settings-updated', () => {
  const h = harness({ projects: [], teams: [] });
  const visions = {
    enabled: true,
    autoFix: true,
    projects: ['p1', 'p2'],
    junk: 'drop-me',
    dispatch: {
      enabled: true,
      quietMs: 30000,
      cooldownMs: 300000,
      maxPerHour: 6,
      activityMaxPerHour: 2,
      dispatchTimeoutSeconds: 180,
      model: 'claude-sonnet-4-20250514',
      junk: 'drop-me',
    },
  };
  const sanitized = {
    enabled: true,
    autoFix: true,
    projects: ['p1', 'p2'],
    dispatch: {
      enabled: true,
      quietMs: 30000,
      cooldownMs: 300000,
      maxPerHour: 6,
      activityMaxPerHour: 2,
      dispatchTimeoutSeconds: 180,
      model: 'claude-sonnet-4-20250514',
    },
  };

  h.send({ type: 'update-settings', settings: { visions } });

  assert.deepEqual(h.cfg.visions, sanitized);
  const updated = h.sent.find((m) => m.type === 'settings-updated');
  assert.ok(updated, 'replied settings-updated');
  assert.deepEqual(updated.settings.visions, sanitized);
  assert.equal(h.reloadCalls.length, 1, 'settings reload still runs once');
});

test('visions validation rejects wrong scalar types and ranges', () => {
  const cases = [
    [{ enabled: 'yes' }, /visions.enabled must be a boolean/],
    [{ autoFix: 'yes' }, /visions.autoFix must be a boolean/],
    [{ projects: 'p1' }, /visions.projects must be an array of strings/],
    [{ projects: ['p1', 7] }, /visions.projects must be an array of strings/],
    [{ dispatch: 'on' }, /visions.dispatch must be an object/],
    [{ dispatch: { enabled: 'yes' } }, /visions.dispatch.enabled must be a boolean/],
    [{ dispatch: { quietMs: 0 } }, /visions.dispatch.quietMs must be a positive number/],
    [{ dispatch: { activityMaxPerHour: -1 } }, /visions.dispatch.activityMaxPerHour must be zero or more/],
    [{ dispatch: { model: 42 } }, /visions.dispatch.model must be a string/],
  ];
  for (const [visions, pattern] of cases) {
    const h = harness({ projects: [], teams: [] });
    h.send({ type: 'update-settings', settings: { visions } });
    const err = h.sent.find((m) => m.type === 'settings-error');
    assert.ok(pattern.test(err?.message || ''), `rejected ${JSON.stringify(visions)}`);
    assert.equal(h.cfg.visions, undefined);
  }
});

// ---------------------------------------------------------------------------
// The posthog block (server/control-handlers.js validatePosthog/sanitizePosthog), same contract as
// prReview above: validated on the way in, persisted sanitized, echoed back, and hot-applied via
// applySettingsReload (which calls the lane's restartIfConfigChanged).
// ---------------------------------------------------------------------------

// Exactly what the Settings dialog's PostHog tab sends (public/dialogs.js save()).
function posthogPayload(over = {}) {
  return {
    enabled: true,
    host: 'https://us.posthog.com',
    apiKey: 'phx_secret',
    projects: [1, 2],
    intervalMinutes: 15,
    maxConcurrentInvestigations: 2,
    investigationTimeoutSeconds: 900,
    minUsersToInvestigate: 1,
    userEscalationThreshold: 25,
    repoPath: '/repo/web',
    autoFix: false,
    fixTimeoutSeconds: 1800,
    trafficSpikeEnabled: true,
    trafficSpikeMultiplier: 3,
    trafficSpikeMinUsers: 10,
    trafficSpikeCooldownMinutes: 360,
    trafficSpikeBaselineDays: 7,
    ...over,
  };
}

test('a valid posthog payload persists, echoes in settings-updated, and hot-applies', () => {
  const h = harness({ projects: [], teams: [] });
  const payload = posthogPayload();

  h.send({ type: 'update-settings', settings: { posthog: payload } });

  assert.deepEqual(h.cfg.posthog, payload);
  const updated = h.sent.find((m) => m.type === 'settings-updated');
  assert.ok(updated, 'replied settings-updated');
  assert.deepEqual(updated.settings.posthog, payload);
  assert.equal(h.reloadCalls.length, 1, 'applySettingsReload invoked once (hot-applies the poller)');
  assert.ok(h.broadcasts.some((m) => m.type === 'settings-updated'));
});

test('a posthog update without the api key leaves the stored key intact', () => {
  const h = harness({ posthog: { enabled: false, apiKey: 'phx_stored', host: 'https://us.posthog.com' }, projects: [], teams: [] });
  const { apiKey, ...withoutApiKey } = posthogPayload();
  h.send({ type: 'update-settings', settings: { posthog: withoutApiKey } });

  assert.equal(h.cfg.posthog.apiKey, 'phx_stored');
  assert.equal(h.cfg.posthog.enabled, true, 'the rest of the block still applied');
});

test('a posthog update carrying a new api key replaces the stored one', () => {
  const h = harness({ posthog: { enabled: false, apiKey: 'phx_stored' }, projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ apiKey: 'phx_fresh' }) } });

  assert.equal(h.cfg.posthog.apiKey, 'phx_fresh');
});

test('posthog projects accepts the "all" sentinel', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ projects: 'all' }) } });
  assert.equal(h.cfg.posthog.projects, 'all');
});

test('posthog projectMap survives a save untouched', () => {
  const h = harness({ projects: [], teams: [] });
  const projectMap = { 1: 'web', 2: 'api' };
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ projectMap }) } });
  assert.deepEqual(h.cfg.posthog.projectMap, projectMap);
});

test('a non-object posthog is rejected with settings-error', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: 'nope' } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /posthog must be an object/.test(m.message)));
  assert.equal(h.cfg.posthog, undefined, 'nothing persisted');
  assert.equal(h.reloadCalls.length, 0, 'no reload on a rejected save');
});

test('a non-boolean posthog.enabled is rejected rather than coerced', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: { enabled: 'yes' } } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /enabled/.test(m.message)));
  assert.equal(h.cfg.posthog, undefined);
});

test('a non-http(s) posthog.host is rejected with settings-error', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ host: 'us.posthog.com' }) } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /http\(s\) URL/.test(m.message)));
  assert.equal(h.cfg.posthog, undefined);
});

test('an empty posthog.host means unset and is accepted (a disabled lane can still be saved)', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ enabled: false, host: '', apiKey: '' }) } });
  assert.equal(h.cfg.posthog.host, '');
  assert.equal(h.cfg.posthog.enabled, false);
});

test('posthog.projects rejects a non-integer or non-positive id', () => {
  for (const projects of [['1'], [0], [-3], [1.5], 'some']) {
    const h = harness({ projects: [], teams: [] });
    h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ projects }) } });
    assert.ok(
      h.sent.find((m) => m.type === 'settings-error' && /projects/.test(m.message)),
      `rejected ${JSON.stringify(projects)}`,
    );
    assert.equal(h.cfg.posthog, undefined);
  }
});

test('a non-positive posthog numeric field is rejected with settings-error', () => {
  for (const key of ['intervalMinutes', 'maxConcurrentInvestigations', 'investigationTimeoutSeconds', 'minUsersToInvestigate', 'userEscalationThreshold', 'recurrenceWindowDays', 'transientRecurrenceLimit']) {
    const h = harness({ projects: [], teams: [] });
    h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ [key]: 0 }) } });
    assert.ok(h.sent.find((m) => m.type === 'settings-error' && new RegExp(key).test(m.message)), `rejected ${key}: 0`);
  }
});

// The traffic spike lane's keys. They ride the same whitelist as the rest of the posthog block, but
// their bounds are their own: a spike multiplier under 1 would fire on every quiet hour, and the
// baseline window has to stay inside what the HogQL query clamps to.
test('a traffic spike multiplier below 1 is rejected', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeMultiplier: 0.5 }) } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /trafficSpikeMultiplier/.test(m.message)));
  assert.equal(h.cfg.posthog, undefined);
});

test('a traffic spike cooldown of zero is accepted (never mute a spike)', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeCooldownMinutes: 0 }) } });
  assert.equal(h.cfg.posthog.trafficSpikeCooldownMinutes, 0);
});

test('a negative traffic spike cooldown is rejected', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeCooldownMinutes: -1 }) } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /trafficSpikeCooldownMinutes/.test(m.message)));
});

test('a traffic baseline window outside 1..30 days is rejected', () => {
  for (const days of [0, 31, 365]) {
    const h = harness({ projects: [], teams: [] });
    h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeBaselineDays: days }) } });
    assert.ok(
      h.sent.find((m) => m.type === 'settings-error' && /trafficSpikeBaselineDays/.test(m.message)),
      `rejected ${days} days`,
    );
  }
});

test('a non-boolean trafficSpikeEnabled is rejected rather than coerced', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeEnabled: 'yes' }) } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /trafficSpikeEnabled/.test(m.message)));
  assert.equal(h.cfg.posthog, undefined);
});

test('trafficSpikeEnabled: false persists rather than being dropped as falsy', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeEnabled: false }) } });
  assert.equal(h.cfg.posthog.trafficSpikeEnabled, false);
});

// The auto-fix dispatch. It pushes branches and opens pull requests, so it is opted into explicitly
// and its longer ceiling is bounded on both sides rather than left as a bare positive number.
test('posthog.autoFix persists both ways and is rejected when it is not a boolean', () => {
  const on = harness({ projects: [], teams: [] });
  on.send({ type: 'update-settings', settings: { posthog: posthogPayload({ autoFix: true }) } });
  assert.equal(on.cfg.posthog.autoFix, true);

  const off = harness({ projects: [], teams: [] });
  off.send({ type: 'update-settings', settings: { posthog: posthogPayload({ autoFix: false }) } });
  assert.equal(off.cfg.posthog.autoFix, false, 'false persists rather than being dropped as falsy');

  const bad = harness({ projects: [], teams: [] });
  bad.send({ type: 'update-settings', settings: { posthog: posthogPayload({ autoFix: 'yes' }) } });
  assert.ok(bad.sent.find((m) => m.type === 'settings-error' && /autoFix/.test(m.message)));
  assert.equal(bad.cfg.posthog, undefined);
});

test('posthog.fixTimeoutSeconds outside 60..21600 is rejected', () => {
  for (const seconds of [0, 59, 21601]) {
    const h = harness({ projects: [], teams: [] });
    h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ fixTimeoutSeconds: seconds }) } });
    assert.ok(
      h.sent.find((m) => m.type === 'settings-error' && /fixTimeoutSeconds/.test(m.message)),
      `rejected ${seconds}s`,
    );
    assert.equal(h.cfg.posthog, undefined);
  }
});

test('posthog.fixTimeoutSeconds inside the range persists', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ fixTimeoutSeconds: 3600 }) } });
  assert.equal(h.cfg.posthog.fixTimeoutSeconds, 3600);
});

test('a non-object posthog.projectMap is rejected with settings-error', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ projectMap: ['web'] }) } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /projectMap/.test(m.message)));
});

// allowStatusWrites/dailyDigest were removed: nothing in the lane consumed them, and persisting a
// key implies behavior behind it.
test('retired posthog keys are dropped rather than persisted', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({
    type: 'update-settings',
    settings: { posthog: posthogPayload({ allowStatusWrites: true, dailyDigest: true }) },
  });
  assert.equal('allowStatusWrites' in h.cfg.posthog, false);
  assert.equal('dailyDigest' in h.cfg.posthog, false);
});

// The recurrence-dedupe keys are hand-edited today (the dialog does not render them), so they have to
// survive a save that never mentions them: the dialog spreads the hydrated object, and only a
// whitelisted key makes it back through sanitizePosthog.
test('the recurrence dedupe keys round-trip, and the kill switch is validated as a boolean', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({
    type: 'update-settings',
    settings: {
      posthog: posthogPayload({ recurrenceDedupe: false, recurrenceWindowDays: 14, transientRecurrenceLimit: 5 }),
    },
  });
  assert.equal(h.cfg.posthog.recurrenceDedupe, false);
  assert.equal(h.cfg.posthog.recurrenceWindowDays, 14);
  assert.equal(h.cfg.posthog.transientRecurrenceLimit, 5);

  const bad = harness({ projects: [], teams: [] });
  bad.send({ type: 'update-settings', settings: { posthog: posthogPayload({ recurrenceDedupe: 'no' }) } });
  assert.ok(bad.sent.find((m) => m.type === 'settings-error' && /recurrenceDedupe/.test(m.message)));
  assert.equal(bad.cfg.posthog, undefined);
});

test('posthog.repoPath persists and is trimmed; a non-string is rejected', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ repoPath: '  /repo/web  ' }) } });
  assert.equal(h.cfg.posthog.repoPath, '/repo/web');

  const bad = harness({ projects: [], teams: [] });
  bad.send({ type: 'update-settings', settings: { posthog: posthogPayload({ repoPath: 7 }) } });
  assert.ok(bad.sent.find((m) => m.type === 'settings-error' && /posthog\.repoPath must be a string/.test(m.message)));
  assert.equal(bad.cfg.posthog, undefined);
});

test('unknown posthog keys are dropped, and host/apiKey are trimmed', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({
    type: 'update-settings',
    settings: { posthog: posthogPayload({ host: '  https://ph.test  ', apiKey: '  k  ', bogus: 'x', projectChoices: [] }) },
  });
  assert.equal(h.cfg.posthog.host, 'https://ph.test');
  assert.equal(h.cfg.posthog.apiKey, 'k');
  assert.equal('bogus' in h.cfg.posthog, false, 'unknown keys never reach config.json');
  assert.equal('projectChoices' in h.cfg.posthog, false);
});

test('a save with no posthog key leaves an existing posthog block untouched', () => {
  const existing = posthogPayload();
  const h = harness({ projects: [], teams: [], posthog: { ...existing } });
  h.send({ type: 'update-settings', settings: { cursorBlink: true } });
  assert.deepEqual(h.cfg.posthog, existing, 'an unrelated save never rewrites the lane config');
});

test('a rejected posthog block blocks the whole save, including unrelated keys', () => {
  const h = harness({ projects: [], teams: [] });
  h.send({ type: 'update-settings', settings: { cursorBlink: true, posthog: { enabled: 'yes' } } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error'));
  assert.equal(h.cfg.cursorBlink, undefined, 'the save is atomic: nothing lands when validation fails');
});

test('posthog validation leaves prReview, telegram and remote alone', () => {
  const h = harness({
    projects: [], teams: [],
    prReview: { enabled: true, projects: ['p1'] },
    remote: { enabled: true, port: 3001 },
  });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload() } });

  assert.deepEqual(h.cfg.prReview, { enabled: true, projects: ['p1'] }, 'prReview untouched');
  assert.deepEqual(h.cfg.remote, { enabled: true, port: 3001 }, 'remote is not settable and is untouched');
  assert.equal(h.cfg.telegram, undefined, 'telegram not written by a posthog-only save');
});

// ---------------------------------------------------------------------------
// Launch defaults (the dev server's debugMode overlay) through the REAL config store: the dialog
// sends every boolean on every save, so an unrelated change must not write this launch's default
// into config.json, which would leak the dev overlay into `npm start` from the same repo config.
// ---------------------------------------------------------------------------

// Runs fn against a real config store over a temp config.json, then restores env + disk.
function withRealStore(cfg, storeOpts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-ctl-settings-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  const prev = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  try {
    const store = createConfigStore(storeOpts);
    return fn(harness(store.config, store), store, () => JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } finally {
    if (prev == null) delete process.env.GLISSA_CONFIG;
    if (prev != null) process.env.GLISSA_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an unrelated save never materializes an untouched launch default', () => {
  withRealStore({ projects: [], teams: [] }, { settingsDefaults: { debugMode: true } }, (h, store, readDisk) => {
    // Exactly what the dialog sends: the changed setting plus the echoed-back debugMode.
    h.send({ type: 'update-settings', settings: { debugMode: true, cursorBlink: true } });

    const onDisk = readDisk();
    assert.equal(onDisk.cursorBlink, true, 'the real change persists');
    assert.equal('debugMode' in onDisk, false, 'the untouched launch default is not written to disk');
    assert.equal('debugMode' in store.config, false, 'nor into the in-memory config');
    assert.equal(store.getSettings().debugMode, true, 'the dev overlay still echoes true');
  });
});

test('flipping the checkbox away from the launch default persists it, and it wins from then on', () => {
  withRealStore({ projects: [], teams: [] }, { settingsDefaults: { debugMode: true } }, (h, store, readDisk) => {
    h.send({ type: 'update-settings', settings: { debugMode: false } });
    assert.equal(readDisk().debugMode, false, 'an explicit choice is persisted');
    assert.equal(store.getSettings().debugMode, false, 'and beats the launch default in the echo');

    // Now that the key exists, re-checking it persists normally: no guard once the value is real.
    h.send({ type: 'update-settings', settings: { debugMode: true } });
    assert.equal(readDisk().debugMode, true);
    assert.equal(store.getSettings().debugMode, true);
  });
});

test('with no launch defaults (production) every boolean persists exactly as before', () => {
  withRealStore({ projects: [], teams: [] }, undefined, (h, store, readDisk) => {
    h.send({ type: 'update-settings', settings: { debugMode: true, cursorBlink: true } });
    const onDisk = readDisk();
    assert.equal(onDisk.debugMode, true, 'no overlay means no guard');
    assert.equal(onDisk.cursorBlink, true);
    assert.equal(store.getSettings().debugMode, true);
  });
});

test('the browser round trip never sees a credential and never blanks one', async () => {
  const [{ SETTINGS_MAP }, view] = await Promise.all([
    import('../public/settings-map.mjs'),
    import('../public/settings-view-core.mjs'),
  ]);
  const telegramSection = SETTINGS_MAP.filter((section) => section.id === 'machine-telegram');
  const stored = {
    telegram: { botToken: 'stored-tok', chatId: '123' },
    posthog: { enabled: true, apiKey: 'phx_stored' },
    projects: [],
    teams: [],
  };

  withRealStore(stored, undefined, (h, store, readDisk) => {
    const firstPayload = store.getSettings();
    assert.equal(JSON.stringify(firstPayload).includes('stored-tok'), false, 'the connect snapshot carries no token');
    assert.equal(JSON.stringify(firstPayload).includes('phx_stored'), false, 'nor the api key');

    const original = view.hydrateFromSettings(telegramSection, firstPayload);
    const edited = view.hydrateFromSettings(telegramSection, firstPayload);
    edited['telegram.chatId'] = '456';
    const settings = view.collectDirtyBlocks(telegramSection, original, edited);
    assert.deepEqual(settings, { telegram: { chatId: '456' } }, 'the mask never leaves the browser');

    h.send({ type: 'update-settings', settings });

    assert.equal(readDisk().telegram.botToken, 'stored-tok', 'the stored token survives a chat-id save');
    assert.equal(readDisk().telegram.chatId, '456');
    assert.equal(store.getSettings().telegram.botTokenConfigured, true);

    const replaced = view.hydrateFromSettings(telegramSection, store.getSettings());
    replaced['telegram.botToken'] = 'fresh-tok';
    h.send({
      type: 'update-settings',
      settings: view.collectDirtyBlocks(telegramSection, original, replaced),
    });
    assert.equal(readDisk().telegram.botToken, 'fresh-tok', 'a pasted token still writes through');
  });
});
