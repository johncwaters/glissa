import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRAIL_DETAIL_MAX_CHARS,
  TRAIL_TOOL_MAX_CHARS,
  appendTrailStep,
  createInvestigationTrail,
  describeToolStep,
  trailStepFromHook,
} from '../server/core/investigation-trail-core.ts';

test('describeToolStep names the tool and picks the one field worth showing per tool', () => {
  assert.deepEqual(describeToolStep('Bash', { command: 'npm test\n&& echo done' }), { tool: 'Bash', detail: 'npm test' });
  assert.deepEqual(describeToolStep('Read', { file_path: '/repo/server/a.ts' }), { tool: 'Read', detail: '/repo/server/a.ts' });
  assert.deepEqual(describeToolStep('Grep', { pattern: 'TypeError', path: '/repo' }), { tool: 'Grep', detail: 'TypeError' });
  assert.deepEqual(describeToolStep('WebFetch', { url: 'https://ph.test/x' }), { tool: 'WebFetch', detail: 'https://ph.test/x' });
});

test('describeToolStep carries an unknown tool with an empty detail and refuses a missing name', () => {
  assert.deepEqual(describeToolStep('mcp__posthog__query', { sql: 'select 1' }), { tool: 'mcp__posthog__query', detail: '' });
  assert.equal(describeToolStep('', { command: 'x' }), null);
  assert.equal(describeToolStep(undefined, undefined), null);
});

test('describeToolStep caps the detail at one line of bounded length', () => {
  const long = 'x'.repeat(TRAIL_DETAIL_MAX_CHARS + 50);
  assert.equal(describeToolStep('Bash', { command: long })?.detail.length, TRAIL_DETAIL_MAX_CHARS);
  assert.equal(describeToolStep('Bash', { command: 42 })?.detail, '');
});

test('describeToolStep caps the tool name so a long mcp tool cannot stretch the row', () => {
  const long = `mcp__${'x'.repeat(TRAIL_TOOL_MAX_CHARS)}`;
  assert.equal(describeToolStep(long, {})?.tool.length, TRAIL_TOOL_MAX_CHARS);
  assert.equal(describeToolStep(long, {})?.tool, long.slice(0, TRAIL_TOOL_MAX_CHARS));
});

test('trailStepFromHook reads only the lowercased pretooluse the hook router routes', () => {
  assert.deepEqual(trailStepFromHook('pretooluse', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }), { tool: 'Edit', detail: 'a.ts' });
  assert.deepEqual(trailStepFromHook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }), { tool: 'Edit', detail: 'a.ts' });
  assert.equal(trailStepFromHook('posttooluse', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }), null);
  assert.equal(trailStepFromHook('stop', {}), null);
});

test('appendTrailStep keeps only the newest steps under the cap', () => {
  let trail = createInvestigationTrail(1000);
  for (let i = 0; i < 5; i++) trail = appendTrailStep(trail, { at: 1000 + i, tool: 'Read', detail: `f${i}` }, 3);
  assert.equal(trail.startedAt, 1000);
  assert.deepEqual(trail.steps.map((step) => step.detail), ['f2', 'f3', 'f4']);
});

test('appendTrailStep never mutates the trail it was given', () => {
  const before = createInvestigationTrail(1);
  const after = appendTrailStep(before, { at: 2, tool: 'Bash', detail: 'ls' });
  assert.equal(before.steps.length, 0);
  assert.equal(after.steps.length, 1);
});
