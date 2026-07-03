'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// teams-panel/format-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/teams-panel/format-core.mjs');

test('key: joins teamId and projectId', async () => {
  const { key } = await importCore();
  assert.equal(key('marketing', 'proj-1'), 'marketing:proj-1');
});

test('labelFor: known stage id uses the display label, unknown id title-cases', async () => {
  const { labelFor } = await importCore();
  assert.equal(labelFor('writer'), 'Writer');
  assert.equal(labelFor('custom'), 'Custom');
  assert.equal(labelFor(''), '');
});

test('classifyVerdict: maps verdict text to a category, case-insensitively', async () => {
  const { classifyVerdict } = await importCore();
  assert.equal(classifyVerdict('SHIP'), 'ship');
  assert.equal(classifyVerdict('fix needed'), 'fix');
  assert.equal(classifyVerdict('BLOCK'), 'block');
  assert.equal(classifyVerdict('halted: dirty tree'), 'failed');
  assert.equal(classifyVerdict('skip'), 'skipped');
  assert.equal(classifyVerdict('anything else'), 'done');
});

test('formatRunDate: extracts date and short weekday from a run id', async () => {
  const { formatRunDate } = await importCore();
  assert.equal(formatRunDate('2026-07-02-thursday'), '2026-07-02 · Thu');
  assert.equal(formatRunDate('2026-07-02'), '2026-07-02');
  assert.equal(formatRunDate(''), '');
  assert.equal(formatRunDate(undefined), '');
});

test('scheduleSummary: renders days/time/tz, blank when no days', async () => {
  const { scheduleSummary } = await importCore();
  assert.equal(scheduleSummary({ days: ['mon', 'wed'], time: '05:00', tz: 'America/Denver' }), 'Mon/Wed 05:00 Denver');
  assert.equal(scheduleSummary(null), '');
  assert.equal(scheduleSummary({ days: [] }), '');
});

test('isValidTz: accepts a real IANA zone, rejects garbage and empty', async () => {
  const { isValidTz } = await importCore();
  assert.equal(isValidTz('America/Denver'), true);
  assert.equal(isValidTz('Not/AZone'), false);
  assert.equal(isValidTz(''), false);
});

test('artifactLabel: strips extension and title-cases', async () => {
  const { artifactLabel } = await importCore();
  assert.equal(artifactLabel('drafts.md'), 'Drafts');
  assert.equal(artifactLabel('review.json'), 'Review');
});

test('mmss: formats seconds as m:ss, clamped at zero', async () => {
  const { mmss } = await importCore();
  assert.equal(mmss(65), '1:05');
  assert.equal(mmss(0), '0:00');
  assert.equal(mmss(-5), '0:00');
});

test('chatRoleLabel: maps role to display label', async () => {
  const { chatRoleLabel } = await importCore();
  assert.equal(chatRoleLabel('operator'), 'You');
  assert.equal(chatRoleLabel('agent'), 'Team');
  assert.equal(chatRoleLabel('system'), '');
});

test('failText: halt, cancelled, and generic reasons', async () => {
  const { failText } = await importCore();
  assert.equal(failText({ reason: 'halt' }), 'No topic available, the content calendar had nothing to cover.');
  assert.equal(failText({ reason: 'cancelled', stage: 'writer' }), 'Cancelled @ Writer');
  assert.equal(failText({ reason: 'timeout', stage: 'editor' }), 'Failed @ Editor · timeout');
  assert.equal(failText({}), 'Failed');
});

test('mergeNote: merged, branched, and neither', async () => {
  const { mergeNote } = await importCore();
  assert.equal(mergeNote({ merged: true, base: 'main' }), ' · merged to main');
  assert.equal(mergeNote({ merged: true }), ' · merged');
  assert.equal(mergeNote({ branch: 'team/run-1' }), ' · on team/run-1');
  assert.equal(mergeNote({}), '');
});
