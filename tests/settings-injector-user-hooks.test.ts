import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TIMEOUT_SEC,
  PLAN_HOLD_RELEASE_MS,
  PLAN_HOOK_TIMEOUT_SEC,
  buildHookSettings,
  describeBuiltinHooks,
} from '../detection/settings-injector.ts';

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

test('observeToolCalls posts every tool call to the relay and is off for an ordinary session', () => {
  assert.equal('PreToolUse' in buildHookSettings(base).hooks, false);
  const settings = buildHookSettings({ ...base, observeToolCalls: true });
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(Object.hasOwn(settings.hooks.PreToolUse[0], 'matcher'), false, 'the trail needs every tool call, not a matched subset');
  const [handler] = settings.hooks.PreToolUse[0].hooks;
  assert.equal(handler.type, 'http');
  assert.match(String(handler.url), /\/hook\/g1\/pretooluse\?t=tok$/);
});

test('the trail hook and the rtk entry coexist, the trail first', () => {
  const settings = buildHookSettings({ ...base, observeToolCalls: true, rtkPath: '/usr/bin/rtk' });
  assert.deepEqual(settings.hooks.PreToolUse.map((entry) => entry.hooks[0].type), ['http', 'command']);
  assert.equal(settings.hooks.PreToolUse[1].matcher, 'Bash');
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
    { rtkPath: '/usr/bin/rtk' },
    { observeToolCalls: true },
    { observeToolCalls: true, rtkPath: '/usr/bin/rtk' },
    { detectScheduledWakeups: false, rtkPath: '/usr/bin/rtk' },
    { planReview: true },
    { planReview: true, rtkPath: '/usr/bin/rtk' },
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

test('an operator PostToolUse hook stays after the built-in matcher', () => {
  const settings = buildHookSettings({
    ...base,
    userHooks: [{
      id: 'read-audit', name: 'read audit', event: 'PostToolUse', matcher: 'Read', type: 'command', command: 'echo', enabled: true,
    }],
  });
  assert.deepEqual(settings.hooks.PostToolUse.map((entry) => entry.hooks[0].type), ['http', 'command']);
});

function byRow(a: { event: string; matcher: string | null }, b: { event: string; matcher: string | null }) {
  return `${a.event}${a.matcher}`.localeCompare(`${b.event}${b.matcher}`);
}

test('the plan entry sits beside an unmatched PermissionRequest entry that stays byte-identical', () => {
  const without = buildHookSettings(base);
  const withPlan = buildHookSettings({ ...base, planReview: true });
  assert.equal(
    JSON.stringify(withPlan.hooks.PermissionRequest[0]),
    JSON.stringify(without.hooks.PermissionRequest[0]),
    'the status signal path must not move when plan review is on',
  );
  assert.equal(withPlan.hooks.PermissionRequest.length, 2);
  assert.deepEqual(withPlan.hooks.PermissionRequest[1], {
    matcher: 'ExitPlanMode',
    hooks: [{ type: 'http', url: 'http://127.0.0.1:3000/hook/g1/permissionrequest-plan?t=tok', timeout: PLAN_HOOK_TIMEOUT_SEC }],
  });
});

test('the plan endpoint is a second URL, so two entries can never arrive as indistinguishable posts', () => {
  const settings = buildHookSettings({ ...base, planReview: true });
  const urls = settings.hooks.PermissionRequest.map((entry) => entry.hooks[0].url);
  assert.equal(new Set(urls).size, 2);
});

test('ExitPlanMode joins the PostToolUse matchers without displacing the wakeup entry', () => {
  const settings = buildHookSettings({ ...base, planReview: true });
  assert.deepEqual(
    settings.hooks.PostToolUse.map((entry) => entry.matcher),
    ['ScheduleWakeup|CronCreate|CronDelete', 'ExitPlanMode'],
  );
});

test('the plan tool result has its own URL segment, so only it carries the raised body cap', () => {
  const settings = buildHookSettings({ ...base, planReview: true });
  assert.deepEqual(
    settings.hooks.PostToolUse.map((entry) => entry.hooks[0].url),
    [
      'http://127.0.0.1:3000/hook/g1/posttooluse?t=tok',
      'http://127.0.0.1:3000/hook/g1/posttooluse-plan?t=tok',
    ],
  );
  assert.equal(settings.hooks.PostToolUse[1].hooks[0].timeout, DEFAULT_TIMEOUT_SEC, 'only the held request waits a day');
});

test('plan review off leaves the settings byte-identical', () => {
  assert.equal(
    JSON.stringify(buildHookSettings({ ...base, planReview: false })),
    JSON.stringify(buildHookSettings(base)),
  );
});

test('the plan hook carries the measured 86400 second ceiling, with the lane releasing a minute early', () => {
  assert.equal(PLAN_HOOK_TIMEOUT_SEC, 86400, 'the bundle applies no clamp and honored 86400 live in spike 3');
  assert.ok(PLAN_HOLD_RELEASE_MS < PLAN_HOOK_TIMEOUT_SEC * 1000, 'the lane always answers before Claude Code abandons the socket');

  const settings = buildHookSettings({ port: 3000, glissaId: 'g1', token: 'tok', planReview: true });
  assert.equal(settings.hooks.PermissionRequest[1].hooks[0].timeout, PLAN_HOOK_TIMEOUT_SEC);
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].timeout, DEFAULT_TIMEOUT_SEC);
});
