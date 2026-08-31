'use strict';

// Operator hooks (the Hooks tab) ride the per-session settings file. What is pinned: none configured
// leaves the file byte-identical, a configured one lands AFTER Glissa's own entry for the same event,
// and the rtk PreToolUse entry is never displaced.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHookSettings, describeBuiltinHooks } = require('../detection/settings-injector');

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
  // No timeout key: the record has none, so Claude Code's own default applies rather than Glissa's 5s.
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

// The Hooks tab lists what this file writes. Hand-derived, that list drifted (it named the rtk entry on
// config.rtk while the file carries it only for a resolved binary), so the rows are derived here.
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
    const written = [];
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

function byRow(a, b) {
  return `${a.event}${a.matcher}`.localeCompare(`${b.event}${b.matcher}`);
}
