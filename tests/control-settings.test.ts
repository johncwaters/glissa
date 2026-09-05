import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore } from '../server/config-store.ts';
import type { ConfigStore, DefaultConfig, GlissaConfig } from '../server/config-store.ts';
import type { ControlMessageRecord } from '../server/control-replay-core.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';

interface SettingsFrame {
  type: string;
  message?: string;
  settings?: Record<string, unknown>;
}

interface SettingsHarness {
  send(message: unknown): unknown;
  sent: SettingsFrame[];
  broadcasts: ControlMessageRecord[];
  reloadCalls: GlissaConfig[];
  cfg: GlissaConfig;
  store: ConfigStore;
}

function harness(cfg: GlissaConfig, store: ConfigStore = testConfigStore(cfg)): SettingsHarness {
  const broadcasts: ControlMessageRecord[] = [];
  const reloadCalls: GlissaConfig[] = [];
  const server = createControlServer(controlDeps(cfg, {
    configStore: store,
    applySettingsReload: (fresh) => { reloadCalls.push(fresh); store.applySettings(fresh); },
    broadcastControl: (message) => { broadcasts.push(message); },
  }));
  const connection = connectControl<SettingsFrame>(server);
  connection.sent.length = 0;
  return { send: connection.send, sent: connection.sent, broadcasts, reloadCalls, cfg, store };
}

function errorFrom(h: SettingsHarness): SettingsFrame | undefined {
  return h.sent.find((message) => message.type === 'settings-error');
}

function updatedFrom(h: SettingsHarness): SettingsFrame | undefined {
  return h.sent.find((message) => message.type === 'settings-updated');
}

function blockOf(value: unknown, key: string): unknown {
  assert.ok(value && typeof value === 'object', `expected an object to read ${key} from`);
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function holdsKey(value: unknown, key: string): boolean {
  assert.ok(value && typeof value === 'object', `expected an object to look ${key} up in`);
  return key in value;
}

test('a valid prReview+telegram payload persists and echoes in settings-updated', () => {
  const h = harness({ projects: [{ id: 'p1', name: 'proj-one', path: 'C:/p1' }] });

  h.send({
    type: 'update-settings',
    settings: {
      prReview: { enabled: true, projects: ['p1'], intervalMinutes: 10, mergeMethod: 'squash', maxConcurrentReviews: 2, reviewTimeoutSeconds: 600 },
      telegram: { botToken: 'tok', chatId: '123' },
    },
  });

  assert.deepEqual(h.cfg.prReview, { enabled: true, projects: ['p1'], intervalMinutes: 10, mergeMethod: 'squash', maxConcurrentReviews: 2, reviewTimeoutSeconds: 600 });
  assert.deepEqual(h.cfg.telegram, { botToken: 'tok', chatId: '123' });

  const updated = updatedFrom(h);
  assert.ok(updated, 'replied settings-updated');
  assert.deepEqual(updated.settings?.prReview, h.cfg.prReview);
  assert.deepEqual(updated.settings?.telegram, h.store.getSettings().telegram, 'the echo is the redacted projection');

  assert.equal(h.reloadCalls.length, 1, 'applySettingsReload invoked once (hot-applies the poller)');
  assert.ok(h.broadcasts.some((m) => m.type === 'settings-updated'), 'broadcast to other clients too');
});

test('an invalid mergeMethod is rejected with settings-error and nothing is persisted', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { prReview: { mergeMethod: 'fast-forward' } } });

  const err = errorFrom(h);
  assert.ok(err && /mergeMethod/.test(String(err.message)));
  assert.equal(h.cfg.prReview, undefined, 'nothing persisted');
  assert.equal(h.reloadCalls.length, 0, 'no reload on a rejected save');
});

test('non-array prReview.projects is rejected with settings-error', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { prReview: { projects: 'p1' } } });

  const err = errorFrom(h);
  assert.ok(err && /projects/.test(String(err.message)));
  assert.equal(h.cfg.prReview, undefined);
});

test('a non-boolean prReview.enabled is rejected with settings-error', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { prReview: { enabled: 'yes' } } });

  const err = errorFrom(h);
  assert.ok(err && /enabled/.test(String(err.message)));
  assert.equal(h.cfg.prReview, undefined);
});

test('a non-positive prReview numeric field is rejected with settings-error', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { prReview: { intervalMinutes: 0 } } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /intervalMinutes/.test(String(m.message))));
});

test('a non-object telegram is rejected with settings-error', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { telegram: 'nope' } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /telegram/.test(String(m.message))));
});

test('a stray projectChoices field is rejected by name without a partial write', () => {
  const h = harness({ projects: [] });
  h.send({
    type: 'update-settings',
    settings: { prReview: { enabled: false }, projectChoices: [{ id: 'x', name: 'y' }] },
  });

  assert.equal(h.cfg.prReview, undefined);
  assert.equal(h.cfg.projectChoices, undefined, 'projectChoices is derived read-only, never written to cfg');
  assert.match(String(errorFrom(h)?.message), /projectChoices/);
});

test('worktree conflict switches remain settable while withheld from settings', () => {
  const h = harness({ projects: [] });
  h.send({
    type: 'update-settings',
    settings: { worktreeAutoRebase: false, worktreeRerere: false },
  });

  assert.equal(h.cfg.worktreeAutoRebase, false);
  assert.equal(h.cfg.worktreeRerere, false);
  assert.equal(h.sent.some((message) => message.type === 'settings-error'), false);
});

test('updateChannel persists, echoes, and hot-applies', () => {
  const h = harness({ projects: [], updateChannel: 'release' });
  h.send({ type: 'update-settings', settings: { updateChannel: 'main' } });
  assert.equal(h.cfg.updateChannel, 'main');
  assert.equal(updatedFrom(h)?.settings?.updateChannel, 'main');
  assert.equal(h.reloadCalls.length, 1);
});

test('updateChannel rejects values outside release and main', () => {
  const h = harness({ projects: [], updateChannel: 'release' });
  h.send({ type: 'update-settings', settings: { updateChannel: 'nightly' } });
  assert.match(String(errorFrom(h)?.message), /updateChannel/);
  assert.equal(h.cfg.updateChannel, 'release');
});

test('a valid branchGc payload is sanitized, persisted, and echoed, and file-only keys sent over the control socket are dropped', () => {
  const h = harness({ projects: [] });
  h.send({
    type: 'update-settings',
    settings: { branchGc: { enabled: true, staleDays: 21, intervalMs: 3600000, unknown: 'drop', prefixes: ['evil/'] } },
  });

  assert.equal(h.cfg.branchGc?.enabled, true);
  assert.equal(h.cfg.branchGc?.staleDays, 21);
  assert.equal(h.cfg.branchGc?.intervalMs, 3600000);
  assert.notDeepEqual(h.cfg.branchGc?.prefixes, ['evil/']);
  const echoed = blockOf(updatedFrom(h)?.settings, 'branchGc');
  assert.equal(blockOf(echoed, 'staleDays'), 21);
  assert.deepEqual(blockOf(echoed, 'prefixes'), ['glissa/session/', 'worktree-agent-']);
});

test('a branchGc control update keeps the stored file-only keys', () => {
  const h = harness({ branchGc: { enabled: true, prefixes: ['custom/'], dryRun: true, staleDays: 14, intervalMs: 3600000 }, projects: [] });
  h.send({ type: 'update-settings', settings: { branchGc: { staleDays: 21, prefixes: ['evil/'] } } });

  assert.deepEqual(h.cfg.branchGc, { enabled: true, prefixes: ['custom/'], dryRun: true, staleDays: 21, intervalMs: 3600000 });
});

test('branchGc rejects non-boolean enablement and non-positive numeric fields', () => {
  for (const branchGc of [{ enabled: 'yes' }, { staleDays: 0 }, { intervalMs: -1 }]) {
    const h = harness({ projects: [] });
    h.send({ type: 'update-settings', settings: { branchGc } });
    assert.ok(h.sent.some((message) => message.type === 'settings-error'));
    assert.equal(h.cfg.branchGc, undefined);
  }
});

test('a settings save that omits branchGc preserves its existing opt-out', () => {
  const h = harness({ branchGc: { enabled: false }, projects: [] });
  h.send({ type: 'update-settings', settings: { cursorBlink: true } });

  assert.deepEqual(h.cfg.branchGc, { enabled: false });
});

test('empty telegram strings persist as-is (means unset), key is not deleted', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { telegram: { botToken: '', chatId: '' } } });

  assert.deepEqual(h.cfg.telegram, { botToken: '', chatId: '' });
});

test('a telegram update without the bot token leaves the stored token intact', () => {
  const h = harness({ telegram: { botToken: 'stored-tok', chatId: '123' }, projects: [] });
  h.send({ type: 'update-settings', settings: { telegram: { chatId: '456' } } });

  assert.deepEqual(h.cfg.telegram, { botToken: 'stored-tok', chatId: '456' });
});

test('a telegram update carrying a new bot token replaces the stored one', () => {
  const h = harness({ telegram: { botToken: 'stored-tok', chatId: '123' }, projects: [] });
  h.send({ type: 'update-settings', settings: { telegram: { botToken: 'fresh-tok', chatId: '123' } } });

  assert.deepEqual(h.cfg.telegram, { botToken: 'fresh-tok', chatId: '123' });
});

test('an explicitly emptied bot token clears the stored one', () => {
  const h = harness({ telegram: { botToken: 'stored-tok', chatId: '123' }, projects: [] });
  h.send({ type: 'update-settings', settings: { telegram: { botToken: '', chatId: '123' } } });

  assert.deepEqual(h.cfg.telegram, { botToken: '', chatId: '123' });
});

test('a valid visions payload persists and echoes in settings-updated', () => {
  const h = harness({ projects: [] });
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
    intent: { threadTtlMs: 3600000, junk: 'drop-me' },
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
    intent: { threadTtlMs: 3600000 },
  };

  h.send({ type: 'update-settings', settings: { visions } });

  assert.deepEqual(h.cfg.visions, sanitized);
  const updated = updatedFrom(h);
  assert.ok(updated, 'replied settings-updated');
  assert.deepEqual(updated.settings?.visions, sanitized);
  assert.equal(h.reloadCalls.length, 1, 'settings reload still runs once');
});

test('visions validation rejects wrong scalar types and ranges', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ enabled: 'yes' }, /visions.enabled must be a boolean/],
    [{ autoFix: 'yes' }, /visions.autoFix must be a boolean/],
    [{ projects: 'p1' }, /visions.projects must be an array of strings/],
    [{ projects: ['p1', 7] }, /visions.projects must be an array of strings/],
    [{ dispatch: 'on' }, /visions.dispatch must be an object/],
    [{ dispatch: { enabled: 'yes' } }, /visions.dispatch.enabled must be a boolean/],
    [{ dispatch: { quietMs: 0 } }, /visions.dispatch.quietMs must be a positive number/],
    [{ dispatch: { activityMaxPerHour: -1 } }, /visions.dispatch.activityMaxPerHour must be zero or more/],
    [{ dispatch: { model: 42 } }, /visions.dispatch.model must be a string/],
    [{ intent: { threadTtlMs: 0 } }, /visions.intent.threadTtlMs must be a positive number/],
  ];
  for (const [visions, pattern] of cases) {
    const h = harness({ projects: [] });
    h.send({ type: 'update-settings', settings: { visions } });
    assert.ok(pattern.test(String(errorFrom(h)?.message ?? '')), `rejected ${JSON.stringify(visions)}`);
    assert.equal(h.cfg.visions, undefined);
  }
});

function posthogPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
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
  const h = harness({ projects: [] });
  const payload = posthogPayload();

  h.send({ type: 'update-settings', settings: { posthog: payload } });

  assert.deepEqual(h.cfg.posthog, payload);
  const updated = updatedFrom(h);
  assert.ok(updated, 'replied settings-updated');
  assert.deepEqual(updated.settings?.posthog, h.store.getSettings().posthog, 'the echo is the redacted projection');
  assert.equal(h.reloadCalls.length, 1, 'applySettingsReload invoked once (hot-applies the poller)');
  assert.ok(h.broadcasts.some((m) => m.type === 'settings-updated'));
});

test('a posthog update without the api key leaves the stored key intact', () => {
  const h = harness({ posthog: { enabled: false, apiKey: 'phx_stored', host: 'https://us.posthog.com' }, projects: [] });
  const { apiKey: _apiKey, ...withoutApiKey } = posthogPayload();
  h.send({ type: 'update-settings', settings: { posthog: withoutApiKey } });

  assert.equal(blockOf(h.cfg.posthog, 'apiKey'), 'phx_stored');
  assert.equal(blockOf(h.cfg.posthog, 'enabled'), true, 'the rest of the block still applied');
});

test('a posthog update carrying a new api key replaces the stored one', () => {
  const h = harness({ posthog: { enabled: false, apiKey: 'phx_stored' }, projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ apiKey: 'phx_fresh' }) } });

  assert.equal(blockOf(h.cfg.posthog, 'apiKey'), 'phx_fresh');
});

test('posthog projects accepts the "all" sentinel', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ projects: 'all' }) } });
  assert.equal(blockOf(h.cfg.posthog, 'projects'), 'all');
});

test('posthog projectMap survives a save untouched', () => {
  const h = harness({ projects: [] });
  const projectMap = { 1: 'web', 2: 'api' };
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ projectMap }) } });
  assert.deepEqual(blockOf(h.cfg.posthog, 'projectMap'), projectMap);
});

test('a non-object posthog is rejected with settings-error', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: 'nope' } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /posthog must be an object/.test(String(m.message))));
  assert.equal(h.cfg.posthog, undefined, 'nothing persisted');
  assert.equal(h.reloadCalls.length, 0, 'no reload on a rejected save');
});

test('a non-boolean posthog.enabled is rejected rather than coerced', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: { enabled: 'yes' } } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /enabled/.test(String(m.message))));
  assert.equal(h.cfg.posthog, undefined);
});

test('a non-http(s) posthog.host is rejected with settings-error', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ host: 'us.posthog.com' }) } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /http\(s\) URL/.test(String(m.message))));
  assert.equal(h.cfg.posthog, undefined);
});

test('an empty posthog.host means unset and is accepted (a disabled lane can still be saved)', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ enabled: false, host: '', apiKey: '' }) } });
  assert.equal(blockOf(h.cfg.posthog, 'host'), '');
  assert.equal(blockOf(h.cfg.posthog, 'enabled'), false);
});

test('posthog.projects rejects a non-integer or non-positive id', () => {
  for (const projects of [['1'], [0], [-3], [1.5], 'some']) {
    const h = harness({ projects: [] });
    h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ projects }) } });
    assert.ok(
      h.sent.find((m) => m.type === 'settings-error' && /projects/.test(String(m.message))),
      `rejected ${JSON.stringify(projects)}`,
    );
    assert.equal(h.cfg.posthog, undefined);
  }
});

test('a non-positive posthog numeric field is rejected with settings-error', () => {
  for (const key of ['intervalMinutes', 'maxConcurrentInvestigations', 'investigationTimeoutSeconds', 'minUsersToInvestigate', 'userEscalationThreshold', 'recurrenceWindowDays', 'transientRecurrenceLimit']) {
    const h = harness({ projects: [] });
    h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ [key]: 0 }) } });
    assert.ok(h.sent.find((m) => m.type === 'settings-error' && new RegExp(key).test(String(m.message))), `rejected ${key}: 0`);
  }
});

test('a traffic spike multiplier below 1 is rejected', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeMultiplier: 0.5 }) } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /trafficSpikeMultiplier/.test(String(m.message))));
  assert.equal(h.cfg.posthog, undefined);
});

test('a traffic spike cooldown of zero is accepted (never mute a spike)', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeCooldownMinutes: 0 }) } });
  assert.equal(blockOf(h.cfg.posthog, 'trafficSpikeCooldownMinutes'), 0);
});

test('a negative traffic spike cooldown is rejected', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeCooldownMinutes: -1 }) } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /trafficSpikeCooldownMinutes/.test(String(m.message))));
});

test('a traffic baseline window outside 1..30 days is rejected', () => {
  for (const days of [0, 31, 365]) {
    const h = harness({ projects: [] });
    h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeBaselineDays: days }) } });
    assert.ok(
      h.sent.find((m) => m.type === 'settings-error' && /trafficSpikeBaselineDays/.test(String(m.message))),
      `rejected ${days} days`,
    );
  }
});

test('a non-boolean trafficSpikeEnabled is rejected rather than coerced', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeEnabled: 'yes' }) } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /trafficSpikeEnabled/.test(String(m.message))));
  assert.equal(h.cfg.posthog, undefined);
});

test('trafficSpikeEnabled: false persists rather than being dropped as falsy', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ trafficSpikeEnabled: false }) } });
  assert.equal(blockOf(h.cfg.posthog, 'trafficSpikeEnabled'), false);
});

test('posthog.autoFix persists both ways and is rejected when it is not a boolean', () => {
  const on = harness({ projects: [] });
  on.send({ type: 'update-settings', settings: { posthog: posthogPayload({ autoFix: true }) } });
  assert.equal(blockOf(on.cfg.posthog, 'autoFix'), true);

  const off = harness({ projects: [] });
  off.send({ type: 'update-settings', settings: { posthog: posthogPayload({ autoFix: false }) } });
  assert.equal(blockOf(off.cfg.posthog, 'autoFix'), false, 'false persists rather than being dropped as falsy');

  const bad = harness({ projects: [] });
  bad.send({ type: 'update-settings', settings: { posthog: posthogPayload({ autoFix: 'yes' }) } });
  assert.ok(bad.sent.find((m) => m.type === 'settings-error' && /autoFix/.test(String(m.message))));
  assert.equal(bad.cfg.posthog, undefined);
});

test('posthog.fixTimeoutSeconds outside 60..21600 is rejected', () => {
  for (const seconds of [0, 59, 21601]) {
    const h = harness({ projects: [] });
    h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ fixTimeoutSeconds: seconds }) } });
    assert.ok(
      h.sent.find((m) => m.type === 'settings-error' && /fixTimeoutSeconds/.test(String(m.message))),
      `rejected ${seconds}s`,
    );
    assert.equal(h.cfg.posthog, undefined);
  }
});

test('posthog.fixTimeoutSeconds inside the range persists', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ fixTimeoutSeconds: 3600 }) } });
  assert.equal(blockOf(h.cfg.posthog, 'fixTimeoutSeconds'), 3600);
});

test('a non-object posthog.projectMap is rejected with settings-error', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ projectMap: ['web'] }) } });
  assert.ok(h.sent.find((m) => m.type === 'settings-error' && /projectMap/.test(String(m.message))));
});

test('retired posthog keys are dropped rather than persisted', () => {
  const h = harness({ projects: [] });
  h.send({
    type: 'update-settings',
    settings: { posthog: posthogPayload({ allowStatusWrites: true, dailyDigest: true }) },
  });
  assert.equal(holdsKey(h.cfg.posthog, 'allowStatusWrites'), false);
  assert.equal(holdsKey(h.cfg.posthog, 'dailyDigest'), false);
});

test('the recurrence dedupe keys round-trip, and the kill switch is validated as a boolean', () => {
  const h = harness({ projects: [] });
  h.send({
    type: 'update-settings',
    settings: {
      posthog: posthogPayload({ recurrenceDedupe: false, recurrenceWindowDays: 14, transientRecurrenceLimit: 5 }),
    },
  });
  assert.equal(blockOf(h.cfg.posthog, 'recurrenceDedupe'), false);
  assert.equal(blockOf(h.cfg.posthog, 'recurrenceWindowDays'), 14);
  assert.equal(blockOf(h.cfg.posthog, 'transientRecurrenceLimit'), 5);

  const bad = harness({ projects: [] });
  bad.send({ type: 'update-settings', settings: { posthog: posthogPayload({ recurrenceDedupe: 'no' }) } });
  assert.ok(bad.sent.find((m) => m.type === 'settings-error' && /recurrenceDedupe/.test(String(m.message))));
  assert.equal(bad.cfg.posthog, undefined);
});

test('posthog.repoPath persists and is trimmed; a non-string is rejected', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload({ repoPath: '  /repo/web  ' }) } });
  assert.equal(blockOf(h.cfg.posthog, 'repoPath'), '/repo/web');

  const bad = harness({ projects: [] });
  bad.send({ type: 'update-settings', settings: { posthog: posthogPayload({ repoPath: 7 }) } });
  assert.ok(bad.sent.find((m) => m.type === 'settings-error' && /posthog\.repoPath must be a string/.test(String(m.message))));
  assert.equal(bad.cfg.posthog, undefined);
});

test('unknown posthog keys are dropped, and host/apiKey are trimmed', () => {
  const h = harness({ projects: [] });
  h.send({
    type: 'update-settings',
    settings: { posthog: posthogPayload({ host: '  https://ph.test  ', apiKey: '  k  ', bogus: 'x', projectChoices: [] }) },
  });
  assert.equal(blockOf(h.cfg.posthog, 'host'), 'https://ph.test');
  assert.equal(blockOf(h.cfg.posthog, 'apiKey'), 'k');
  assert.equal(holdsKey(h.cfg.posthog, 'bogus'), false, 'unknown keys never reach config.json');
  assert.equal(holdsKey(h.cfg.posthog, 'projectChoices'), false);
});

test('a save with no posthog key leaves an existing posthog block untouched', () => {
  const existing = posthogPayload();
  const h = harness({ projects: [], posthog: { ...existing } });
  h.send({ type: 'update-settings', settings: { cursorBlink: true } });
  assert.deepEqual(h.cfg.posthog, existing, 'an unrelated save never rewrites the lane config');
});

test('a rejected posthog block blocks the whole save, including unrelated keys', () => {
  const h = harness({ projects: [] });
  h.send({ type: 'update-settings', settings: { cursorBlink: true, posthog: { enabled: 'yes' } } });
  assert.ok(errorFrom(h));
  assert.equal(h.cfg.cursorBlink, undefined, 'the save is atomic: nothing lands when validation fails');
});

test('posthog validation leaves prReview, telegram and remote alone', () => {
  const h = harness({
    projects: [],
    prReview: { enabled: true, projects: ['p1'] },
    remote: { enabled: true, port: 3001 },
  });
  h.send({ type: 'update-settings', settings: { posthog: posthogPayload() } });

  assert.deepEqual(h.cfg.prReview, { enabled: true, projects: ['p1'] }, 'prReview untouched');
  assert.deepEqual(h.cfg.remote, { enabled: true, port: 3001 }, 'remote is not settable and is untouched');
  assert.equal(h.cfg.telegram, undefined, 'telegram not written by a posthog-only save');
});

function withRealStore(
  seed: Record<string, unknown>,
  storeOpts: { settingsDefaults?: Partial<DefaultConfig> } | undefined,
  fn: (h: SettingsHarness, store: ConfigStore, readDisk: () => Record<string, unknown>) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-ctl-settings-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(seed, null, 2), 'utf8');
  const prev = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  try {
    const store = createConfigStore(storeOpts);
    fn(harness(store.config, store), store, () => JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } finally {
    if (prev == null) delete process.env.GLISSA_CONFIG;
    if (prev != null) process.env.GLISSA_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an unrelated save never materializes an untouched launch default', () => {
  withRealStore({ projects: [] }, { settingsDefaults: { debugMode: true } }, (h, store, readDisk) => {
    h.send({ type: 'update-settings', settings: { debugMode: true, cursorBlink: true } });

    const onDisk = readDisk();
    assert.equal(onDisk.cursorBlink, true, 'the real change persists');
    assert.equal('debugMode' in onDisk, false, 'the untouched launch default is not written to disk');
    assert.equal('debugMode' in store.config, false, 'nor into the in-memory config');
    assert.equal(store.getSettings().debugMode, true, 'the dev overlay still echoes true');
  });
});

test('flipping the checkbox away from the launch default persists it, and it wins from then on', () => {
  withRealStore({ projects: [] }, { settingsDefaults: { debugMode: true } }, (h, store, readDisk) => {
    h.send({ type: 'update-settings', settings: { debugMode: false } });
    assert.equal(readDisk().debugMode, false, 'an explicit choice is persisted');
    assert.equal(store.getSettings().debugMode, false, 'and beats the launch default in the echo');

    h.send({ type: 'update-settings', settings: { debugMode: true } });
    assert.equal(readDisk().debugMode, true);
    assert.equal(store.getSettings().debugMode, true);
  });
});

test('with no launch defaults (production) every boolean persists exactly as before', () => {
  withRealStore({ projects: [] }, undefined, (h, store, readDisk) => {
    h.send({ type: 'update-settings', settings: { debugMode: true, cursorBlink: true } });
    const onDisk = readDisk();
    assert.equal(onDisk.debugMode, true, 'no overlay means no guard');
    assert.equal(onDisk.cursorBlink, true);
    assert.equal(store.getSettings().debugMode, true);
  });
});

test('the browser round trip never sees a credential and never blanks one', async () => {
  const [{ SETTINGS_MAP }, view] = await Promise.all([
    import('../public/settings-map.ts'),
    import('../public/settings-view-core.ts'),
  ]);
  const telegramSection = SETTINGS_MAP.filter((section) => section.id === 'machine-telegram');
  const stored = {
    telegram: { botToken: 'stored-tok', chatId: '123' },
    posthog: { enabled: true, apiKey: 'phx_stored' },
    projects: [],
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

    assert.equal(blockOf(readDisk().telegram, 'botToken'), 'stored-tok', 'the stored token survives a chat-id save');
    assert.equal(blockOf(readDisk().telegram, 'chatId'), '456');
    assert.equal(blockOf(store.getSettings().telegram, 'botTokenConfigured'), true);

    const replaced = view.hydrateFromSettings(telegramSection, store.getSettings());
    replaced['telegram.botToken'] = 'fresh-tok';
    h.send({
      type: 'update-settings',
      settings: view.collectDirtyBlocks(telegramSection, original, replaced),
    });
    assert.equal(blockOf(readDisk().telegram, 'botToken'), 'fresh-tok', 'a pasted token still writes through');
  });
});
