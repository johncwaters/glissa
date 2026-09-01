import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHookSettings, describeBuiltinHooks } from '../detection/settings-injector.ts';

const base = { port: 3000, glissaId: 'g1', token: 'tok' };

test('no user hooks leaves the settings byte-identical', () => {
  const without = buildHookSettings(base);
  const withEmpty = buildHookSettings({ ...base, userHooks: [] });
  assert.equal(JSON.stringify(withEmpty), JSON.stringify(without));
});

test('a user hook on an event Glissa subscribes to lands after the Glissa entry', () => {
  const settings = buildHookSettings({ ...base, userHooks: [
    { id: 'a', name: 'a', event: 'Stop', type: 'command', command: 'notify-send done', enabled: true },
  ] });
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks[0].type, 'http');

  assert.deepEqual(settings.hooks.Stop[1], { hooks: [{ type: 'command', command: 'notify-send done' }] });
});

test('a user PreToolUse hook does not displace the rtk entry', () => {
  const settings = buildHookSettings({ ...base, rtkPath: '/usr/bin/rtk', userHooks: [
    { id: 'a', name: 'a', event: 'PreToolUse', matcher: 'Edit', type: 'command', command: 'echo', enabled: true },
  ] });
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[1].matcher, 'Edit');
});

test('a user hook on an event Glissa does not subscribe to creates that key', () => {
  const settings = buildHookSettings({ ...base, userHooks: [
    { id: 'a', name: 'a', event: 'PreCompact', matcher: 'auto', type: 'http', url: 'http://127.0.0.1:1/x', timeout: 9, enabled: true },
  ] });
  assert.deepEqual(settings.hooks.PreCompact, [{ matcher: 'auto', hooks: [{ type: 'http', url: 'http://127.0.0.1:1/x', timeout: 9 }] }]);
});

test('describeBuiltinHooks rows are exactly the entries buildHookSettings writes', () => {
  for (const options of [
    {},
    { detectScheduledWakeups: false },
    { detectPackReads: true },
    { detectScheduledWakeups: false, detectPackReads: true },
    { rtkPath: '/usr/bin/rtk' },
    { detectScheduledWakeups: false, detectPackReads: true, rtkPath: '/usr/bin/rtk' },
  ]) {
    const settings = buildHookSettings({ ...base, ...options });
    const written: { event: string; matcher: string | null }[] = [];
    for (const [event, entries] of Object.entries(settings.hooks)) {
      for (const entry of entries) written.push({ event, matcher: entry.matcher ?? null });
    }
    const described = describeBuiltinHooks(options).map((row) => ({ event: row.event, matcher: row.matcher }));
    assert.deepEqual(described.slice().sort(byRow), written.slice().sort(byRow), JSON.stringify(options));
  }
});

test('an operator PostToolUse hook stays after both built-in matchers', () => {
  const settings = buildHookSettings({
    ...base,
    detectPackReads: true,
    userHooks: [{
      id: 'read-audit', name: 'read audit', event: 'PostToolUse', matcher: 'Read', type: 'command', command: 'echo', enabled: true,
    }],
  });
  assert.deepEqual(settings.hooks.PostToolUse.map((entry) => entry.hooks[0].type), ['http', 'http', 'command']);
});

function byRow(a: { event: string; matcher: string | null }, b: { event: string; matcher: string | null }) {
  return `${a.event}${a.matcher}`.localeCompare(`${b.event}${b.matcher}`);
}
