import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_DIFF_CONTEXT_LINES, PLAN_DIFF_MAX_LINES, diffPlanBodies } from '../public/plan/plan-diff-core.ts';
import type { PlanDiff } from '../public/plan/plan-diff-core.ts';

function shape(diff: PlanDiff): string[] {
  return diff.lines.map((line) => `${line.kind[0]} ${line.text}`);
}

test('two identical bodies diff to nothing but unchanged lines', () => {
  const body = '# Ship it\n\n1. build\n2. land\n';
  const diff = diffPlanBodies(body, body);
  assert.equal(diff.isTooLarge, false);
  assert.deepEqual(diff.lines.map((line) => line.kind), Array(5).fill('unchanged'));
});

test('an inserted line is the only added line, with everything around it unchanged', () => {
  const diff = diffPlanBodies('# Ship it\n1. build\n2. land\n', '# Ship it\n1. build\n1.5 test\n2. land\n');
  assert.deepEqual(shape(diff), [
    'u # Ship it',
    'u 1. build',
    'a 1.5 test',
    'u 2. land',
    'u ',
  ]);
});

test('a deleted line is the only removed line', () => {
  const diff = diffPlanBodies('# Ship it\n1. build\n2. land\n', '# Ship it\n2. land\n');
  assert.deepEqual(shape(diff), [
    'u # Ship it',
    'r 1. build',
    'u 2. land',
    'u ',
  ]);
});

test('a replaced line reads as its removal followed by its replacement', () => {
  const diff = diffPlanBodies('# Ship it\n1. build\n2. land\n', '# Ship it\n1. build it twice\n2. land\n');
  assert.deepEqual(shape(diff), [
    'u # Ship it',
    'r 1. build',
    'a 1. build it twice',
    'u 2. land',
    'u ',
  ]);
});

test('a body that only grew at the end collapses its shared prefix to context lines around one skip', () => {
  const before = Array.from({ length: 500 }, (_unused, index) => `line ${index}`).join('\n');
  const diff = diffPlanBodies(before, `${before}\nline 500`);
  assert.deepEqual(shape(diff), [
    'u line 0',
    'u line 1',
    'u line 2',
    's 494 unchanged lines',
    'u line 497',
    'u line 498',
    'u line 499',
    'a line 500',
  ]);
});

test('an empty body against a full one is all additions, and the reverse is all removals', () => {
  const grown = diffPlanBodies('', '# Ship it\n1. build');
  assert.deepEqual(shape(grown), ['r ', 'a # Ship it', 'a 1. build']);
  const emptied = diffPlanBodies('# Ship it\n1. build', '');
  assert.deepEqual(shape(emptied), ['r # Ship it', 'r 1. build', 'a ']);
});

test('a CRLF body diffs against an LF body as the same text', () => {
  const diff = diffPlanBodies('# Ship it\r\n1. build\r\n', '# Ship it\n1. build\n');
  assert.deepEqual(diff.lines.map((line) => line.kind), ['unchanged', 'unchanged', 'unchanged']);
});

test('two bodies whose changed middle passes the cap report too large instead of locking the tab', () => {
  const before = Array.from({ length: PLAN_DIFF_MAX_LINES }, (_unused, index) => `before ${index}`).join('\n');
  const after = Array.from({ length: PLAN_DIFF_MAX_LINES }, (_unused, index) => `after ${index}`).join('\n');
  const startedAt = Date.now();
  const diff = diffPlanBodies(before, after);
  assert.equal(diff.isTooLarge, true);
  assert.deepEqual(diff.lines, []);
  assert.ok(Date.now() - startedAt < 50, 'an over-cap pair is refused without running the comparison');
});

test('a shared prefix and suffix keep a large pair under the cap, so only the middle is compared', () => {
  const shared = Array.from({ length: 4000 }, (_unused, index) => `line ${index}`);
  const before = [...shared, 'the old middle', ...shared].join('\n');
  const after = [...shared, 'the new middle', ...shared].join('\n');
  const diff = diffPlanBodies(before, after);
  assert.equal(diff.isTooLarge, false, 'trimming the shared ends is what keeps a long plan diffable');
  assert.deepEqual(
    diff.lines.filter((line) => line.kind !== 'unchanged'),
    [
      { kind: 'skipped', text: '3994 unchanged lines' },
      { kind: 'removed', text: 'the old middle' },
      { kind: 'added', text: 'the new middle' },
      { kind: 'skipped', text: '3994 unchanged lines' },
    ],
  );
  assert.equal(diff.lines.length, (PLAN_DIFF_CONTEXT_LINES * 4) + 4, 'each shared end renders context, one skip, context');
});

test('two near-identical bodies of a hundred thousand lines render a handful of rows, never one per line', () => {
  const lineCount = 100000;
  const before = Array.from({ length: lineCount }, (_unused, index) => `line ${index}`);
  const after = [...before];
  after[lineCount / 2] = 'the one changed line';
  const startedAt = Date.now();
  const diff = diffPlanBodies(before.join('\n'), after.join('\n'));
  assert.equal(diff.isTooLarge, false);
  assert.deepEqual(shape(diff), [
    'u line 0',
    'u line 1',
    'u line 2',
    's 49994 unchanged lines',
    'u line 49997',
    'u line 49998',
    'u line 49999',
    'r line 50000',
    'a the one changed line',
    'u line 50001',
    'u line 50002',
    'u line 50003',
    's 49993 unchanged lines',
    'u line 99997',
    'u line 99998',
    'u line 99999',
  ]);
  assert.ok(Date.now() - startedAt < 2000, 'a body under the size cap is diffed without locking the tab');
});

test('two identical bodies of a hundred thousand lines collapse to one skip between context lines', () => {
  const body = Array.from({ length: 100000 }, (_unused, index) => `line ${index}`).join('\n');
  const diff = diffPlanBodies(body, body);
  assert.equal(diff.lines.length, (PLAN_DIFF_CONTEXT_LINES * 2) + 1);
  assert.deepEqual(diff.lines[PLAN_DIFF_CONTEXT_LINES], { kind: 'skipped', text: '99994 unchanged lines' });
});
