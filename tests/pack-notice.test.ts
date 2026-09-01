// Pure notice text for the live context-pack channel (session/core/pack-notice.ts): what a session
// tells its next turn when a pack it spawned against has been rebuilt. The wiring that consumes this
// lives in tests/session-pack-notice.test.js and tests/backend-pack-notice-hook.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPackNotice,
  listStalePacks,
  shouldHoldTerminalStopForNotice,
  MAX_LISTED_PACKS,
  MAX_NOTICE_CHARS,
} from '../session/core/pack-notice.ts';
import type { DeliveredPack } from '../session/core/pack-notice.ts';

test('only a terminal Stop that owes its response a notice stays running', () => {
  const stopWithNotice = {
    event: 'Stop',
    signal: 'ready',
    isNoticePending: true,
    packNoticeHookEvent: 'Stop',
  };
  assert.equal(shouldHoldTerminalStopForNotice(stopWithNotice), true);
  assert.equal(shouldHoldTerminalStopForNotice({ ...stopWithNotice, isNoticePending: false }), false);
  assert.equal(shouldHoldTerminalStopForNotice({ ...stopWithNotice, packNoticeHookEvent: 'UserPromptSubmit' }), false);
  assert.equal(shouldHoldTerminalStopForNotice({ ...stopWithNotice, signal: 'awaiting-input' }), false);
});

test('nothing stale yields no notice', () => {
  assert.equal(buildPackNotice([], {}), null, 'no delivered packs');
  assert.equal(buildPackNotice([{ name: 'a', version: 'v1' }], {}), null, 'no latest version known');
  assert.equal(buildPackNotice([{ name: 'a', version: 'v1' }], { a: 'v1' }), null, 'latest equals delivered');
  assert.equal(buildPackNotice(null, { a: 'v2' }), null, 'a non-array delivered list is not a crash');
});

test('a pack the session never delivered cannot make it stale', () => {
  assert.equal(buildPackNotice([{ name: 'a', version: 'v1' }], { b: 'v9' }), null);
  assert.deepEqual(listStalePacks([{ name: 'a', version: 'v1' }], { b: 'v9' }), []);
});

test('one stale pack names it, both versions, and the re-read guidance', () => {
  const notice = buildPackNotice([{ name: 'house-rules', version: 'aaaaaaaaaaaabbbb' }], { 'house-rules': 'ccccccccccccdddd' });
  assert.equal(
    notice,
    '[glissa] Context pack updated since this session started: "house-rules" (version aaaaaaaaaaaa is now cccccccccccc). '
    + 'The pack CLAUDE.md and rules text loaded at spawn may be out of date. '
    + 'Re-read the files under the pack directory added to this session if they matter for this turn.',
  );
});

test('a Map of latest versions reads the same as a plain object', () => {
  const delivered = [{ name: 'a', version: 'v1' }];
  const fromMap = buildPackNotice(delivered, new Map([['a', 'v2']]));
  assert.ok(fromMap);
  assert.equal(fromMap, buildPackNotice(delivered, { a: 'v2' }));
  assert.match(fromMap, /"a" \(version v1 is now v2\)/);
});

test('several stale packs list together, only the stale ones', () => {
  const notice = buildPackNotice(
    [{ name: 'a', version: 'v1' }, { name: 'b', version: 'v1' }, { name: 'c', version: 'v1' }],
    { a: 'v2', b: 'v1', c: 'v3' },
  );
  assert.ok(notice);
  assert.match(notice, /^\[glissa\] Context packs updated since this session started: "a" \(version v1 is now v2\); "c" \(version v1 is now v3\)\./);
  assert.doesNotMatch(notice, /"b"/, 'a pack still on its delivered version is not listed');
});

test('a long list truncates to a handful plus an "and N more" tail', () => {
  const delivered: DeliveredPack[] = [];
  const latest: Record<string, string> = {};
  for (let i = 0; i < MAX_LISTED_PACKS + 4; i += 1) {
    delivered.push({ name: `pack-${i}`, version: 'v1' });
    latest[`pack-${i}`] = 'v2';
  }
  const notice = buildPackNotice(delivered, latest);
  assert.ok(notice);
  assert.match(notice, /and 4 more\./);
  assert.match(notice, /"pack-0"/);
  assert.doesNotMatch(notice, /"pack-6"/, 'past the listed cap only the count survives');
});

test('the notice is hard-capped well under the additionalContext limit', () => {
  const longName = 'p'.repeat(200);
  const delivered: DeliveredPack[] = [];
  const latest: Record<string, string> = {};
  for (let i = 0; i < 10; i += 1) {
    delivered.push({ name: `${longName}-${i}`, version: 'v'.repeat(80) });
    latest[`${longName}-${i}`] = 'w'.repeat(80);
  }
  const notice = buildPackNotice(delivered, latest);
  assert.ok(notice);
  assert.ok(notice.length <= MAX_NOTICE_CHARS, `notice is ${notice.length} chars`);
  assert.ok(MAX_NOTICE_CHARS < 10000, 'the cap stays far below the Claude Code additionalContext limit');
  assert.match(notice, / \(truncated\)$/);
});

test('the notice carries no pack content, only names, versions and Glissa wording', () => {
  const notice = buildPackNotice([{ name: 'secrets', version: 'v1' }], { secrets: 'v2' });
  assert.ok(notice);
  assert.ok(notice.startsWith('[glissa] '), 'always attributed to Glissa');
  assert.ok(!notice.includes('\n'), 'a single line, so nothing can be smuggled as fenced content');
});
