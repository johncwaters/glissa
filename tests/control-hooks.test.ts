import test from 'node:test';
import assert from 'node:assert/strict';

import type { GlissaConfig } from '../server/config-store.ts';
import type { ControlMessageRecord } from '../server/control-replay-core.ts';
import { HOOK_EVENTS } from '../detection/settings-injector.ts';
import { MAX_TIMEOUT_SEC, rawStoredHooks, readStoredHooks } from '../session/core/user-hooks-core.ts';
import type { UserHook } from '../session/core/user-hooks-core.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';

interface HooksFrame {
  type: string;
  requestId?: string;
  ok?: boolean;
  error?: string | null;
  id?: string;
  count?: number;
  hook?: UserHook;
  hooks?: UserHook[];
  events?: { name: string }[];
  projects?: { id: string; name: string; agent: string }[];
  builtin?: { event: string; matcher: string | null; purpose: string }[];
  limits?: { maxTimeoutSec: number };
}

interface HarnessOptions {
  saveFails?: boolean;
  rtkPath?: string | null;
}

function harness(config: GlissaConfig, { saveFails = false, rtkPath = '/usr/bin/rtk' }: HarnessOptions = {}) {
  const broadcasts: ControlMessageRecord[] = [];
  const reloads: GlissaConfig[] = [];
  const server = createControlServer(controlDeps(config, {
    configStore: testConfigStore(config, { saveFails }),
    applyConfigReload: (fresh) => { reloads.push(fresh); },
    broadcastControl: (message) => { broadcasts.push(message); },
    resolveRtkPath: () => rtkPath,
  }));
  const connection = connectControl<HooksFrame>(server);
  connection.sent.length = 0;
  return { send: connection.send, sent: connection.sent, broadcasts, reloads };
}

const record = (overrides: Partial<UserHook> = {}): UserHook => ({
  id: 'h1', name: 'Lint', event: 'PostToolUse', matcher: 'Edit', type: 'command', command: 'npm run lint', enabled: true, ...overrides,
});

function storedIds(config: GlissaConfig): unknown[] {
  return rawStoredHooks(config.hooks).map((hook) => hook.id);
}

function storedHook(config: GlissaConfig, id: string): UserHook | undefined {
  return readStoredHooks(config.hooks).find((hook) => hook.id === id);
}

test('request-hooks-report answers the stored records, the catalog, the built-in hooks and the projects', async () => {
  const config: GlissaConfig = {
    projects: [{ id: 'p1', name: 'glissa', path: '/r' }, { id: 'p2', name: 'codex', path: '/c', agent: 'codex' }],
    hooks: [record(), { id: 'broken' }],
    rtk: true,
  };
  const h = harness(config);
  await h.send({ type: 'request-hooks-report', requestId: 'r1' });
  const report = h.sent.find((m) => m.type === 'hooks-report');
  assert.ok(report, 'answered a hooks-report');
  assert.equal(report.requestId, 'r1');
  assert.deepEqual(report.hooks, [record()]);
  assert.ok(report.events?.some((entry) => entry.name === 'PreToolUse'));
  assert.deepEqual(report.projects, [{ id: 'p1', name: 'glissa', agent: 'claude-code' }, { id: 'p2', name: 'codex', agent: 'codex' }]);
  const builtinEvents = (report.builtin ?? []).map((row) => row.event);
  for (const event of HOOK_EVENTS) assert.ok(builtinEvents.includes(event), event);
  assert.ok(report.builtin?.some((row) => row.event === 'PreToolUse' && row.matcher === 'Bash'), 'rtk entry when config.rtk');
  assert.ok(report.builtin?.some((row) => row.event === 'PostToolUse'), 'wakeup tracking entry');
  assert.ok(report.builtin?.some((row) => row.event === 'PostToolUse' && row.matcher === 'Read' && row.purpose === 'Pack read tracking'));
  assert.deepEqual(report.limits, { maxTimeoutSec: MAX_TIMEOUT_SEC });
});

test('the rtk row is listed on the resolved binary, not on config.rtk alone', async () => {
  const h = harness({ projects: [], rtk: true }, { rtkPath: null });
  await h.send({ type: 'request-hooks-report', requestId: 'r1' });
  const report = h.sent.find((m) => m.type === 'hooks-report');
  assert.deepEqual(report?.builtin?.filter((row) => row.purpose.includes('rtk')), []);
});

test('a stored record the core cannot read survives an unrelated save and an unrelated delete', async () => {
  const future = { id: 'future', name: 'f', event: 'NotYetKnown', type: 'command', command: 'x', enabled: true };
  const config: GlissaConfig = { projects: [], hooks: [future, record()] };
  const h = harness(config);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: record({ name: 'Lint 2' }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result')?.ok, true);
  assert.deepEqual(storedIds(config), ['future', 'h1']);
  assert.deepEqual(rawStoredHooks(config.hooks)[0], future);
  assert.equal(storedHook(config, 'h1')?.name, 'Lint 2');

  h.sent.length = 0;
  await h.send({ type: 'delete-hook', requestId: 'r2', id: 'h1' });
  assert.equal(h.sent.find((m) => m.type === 'delete-hook-result')?.ok, true);
  assert.deepEqual(rawStoredHooks(config.hooks), [future]);
});

test('save-hook mints an id for a new hook, persists it, reloads and broadcasts', async () => {
  const config: GlissaConfig = { projects: [{ id: 'p1', name: 'glissa', path: '/r' }] };
  const h = harness(config);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: { name: ' Notify ', event: 'Stop', type: 'http', url: 'http://127.0.0.1:1/x', projects: ['p1'] } });
  const result = h.sent.find((m) => m.type === 'save-hook-result');
  assert.equal(result?.ok, true);
  assert.equal(typeof result?.hook?.id, 'string');
  assert.equal(result?.hook?.name, 'Notify');
  assert.deepEqual(rawStoredHooks(config.hooks), [result?.hook]);
  assert.equal(h.reloads.length, 1);
  assert.deepEqual(h.broadcasts, [{ type: 'hooks-updated', count: 1 }]);
});

test('save-hook with an id replaces that record and refuses an id it does not hold', async () => {
  const config: GlissaConfig = { projects: [], hooks: [record()] };
  const h = harness(config);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: record({ enabled: false }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result')?.ok, true);
  assert.equal(rawStoredHooks(config.hooks).length, 1);
  assert.equal(storedHook(config, 'h1')?.enabled, false);

  h.sent.length = 0;
  await h.send({ type: 'save-hook', requestId: 'r2', hook: record({ id: 'nope' }) });
  const refused = h.sent.find((m) => m.type === 'save-hook-result');
  assert.equal(refused?.ok, false);
  assert.equal(refused?.error, 'Unknown hook');
  assert.equal(rawStoredHooks(config.hooks).length, 1);
  assert.equal(h.reloads.length, 1);
});

test('save-hook refuses an invalid record with the core message and writes nothing', async () => {
  const config: GlissaConfig = { projects: [] };
  const h = harness(config);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: { name: 'x', event: 'Stop', matcher: 'y', type: 'command', command: 'z' } });
  const result = h.sent.find((m) => m.type === 'save-hook-result');
  assert.equal(result?.ok, false);
  assert.equal(result?.error, 'Stop takes no matcher');
  assert.equal('hooks' in config, false);
  assert.equal(h.reloads.length, 0);
  assert.equal(h.broadcasts.length, 0);
});

test('save-hook refuses a project the config does not hold', async () => {
  const config: GlissaConfig = { projects: [{ id: 'p1', name: 'glissa', path: '/r' }] };
  const h = harness(config);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: record({ id: undefined, projects: ['p9'] }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result')?.error, 'Unknown project p9');
});

test('an edit keeps a scope naming a project that left config; a new hook still may not name one', async () => {
  const config: GlissaConfig = { projects: [{ id: 'p1', name: 'glissa', path: '/r' }], hooks: [record({ projects: ['gone'] })] };
  const h = harness(config);
  await h.send({ type: 'save-hook', requestId: 'r1', hook: record({ projects: ['gone'], enabled: false }) });
  const result = h.sent.find((m) => m.type === 'save-hook-result');
  assert.equal(result?.ok, true);
  assert.deepEqual(result?.hook?.projects, ['gone']);
  assert.deepEqual(storedHook(config, 'h1')?.projects, ['gone']);
  assert.equal(storedHook(config, 'h1')?.enabled, false);

  h.sent.length = 0;
  await h.send({ type: 'save-hook', requestId: 'r2', hook: record({ projects: ['gone', 'alsoGone'] }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result')?.error, 'Unknown project alsoGone');

  h.sent.length = 0;
  await h.send({ type: 'save-hook', requestId: 'r3', hook: record({ id: undefined, projects: ['gone'] }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result')?.error, 'Unknown project gone');
});

test('a failed config write is reported, not swallowed', async () => {
  const config: GlissaConfig = { projects: [] };
  const h = harness(config, { saveFails: true });
  await h.send({ type: 'save-hook', requestId: 'r1', hook: record({ id: undefined }) });
  assert.equal(h.sent.find((m) => m.type === 'save-hook-result')?.error, 'Could not write config.json');
});

test('delete-hook removes the record, drops the key when none remain, and refuses an unknown id', async () => {
  const config: GlissaConfig = { projects: [], hooks: [record(), record({ id: 'h2' })] };
  const h = harness(config);
  await h.send({ type: 'delete-hook', requestId: 'r1', id: 'h1' });
  assert.deepEqual(h.sent.find((m) => m.type === 'delete-hook-result'), { type: 'delete-hook-result', requestId: 'r1', ok: true, error: null, id: 'h1' });
  assert.deepEqual(storedIds(config), ['h2']);

  h.sent.length = 0;
  await h.send({ type: 'delete-hook', requestId: 'r2', id: 'h2' });
  assert.equal('hooks' in config, false);
  assert.deepEqual(h.broadcasts.at(-1), { type: 'hooks-updated', count: 0 });

  h.sent.length = 0;
  await h.send({ type: 'delete-hook', requestId: 'r3', id: 'h2' });
  assert.equal(h.sent.find((m) => m.type === 'delete-hook-result')?.error, 'Unknown hook');
  assert.equal(h.reloads.length, 2);
});

test('a malformed hooks request receives its typed error reply', async () => {
  const h = harness({ projects: [] });
  await h.send({ type: 'save-hook', requestId: 'r1', hook: 'nope' });
  const result = h.sent.find((m) => m.type === 'save-hook-result');
  assert.equal(result?.ok, false);
  assert.equal(typeof result?.error, 'string');
  h.sent.length = 0;
  await h.send({ type: 'delete-hook', requestId: 'r2' });
  assert.equal(h.sent.find((m) => m.type === 'delete-hook-result')?.ok, false);
});

test('delete-hook removes a stored record this build cannot read, so a hand edit is never the only way out', async () => {
  const config: GlissaConfig = {
    projects: [],
    hooks: [record(), { id: 'future', name: 'f', event: 'NotYetKnown', type: 'command', command: 'x', enabled: true }],
  };
  const h = harness(config);
  await h.send({ type: 'delete-hook', requestId: 'r1', id: 'future' });
  assert.equal(h.sent.find((m) => m.type === 'delete-hook-result')?.ok, true);
  assert.deepEqual(storedIds(config), ['h1']);
});
