'use strict';

// The Glissa lanes section of the Usage tab: which of Glissa's own automation lanes the spend belonged to.

const test = require('node:test');
const assert = require('node:assert/strict');

const importCore = () => import('../public/usage-view-core.mjs');

test('laneRows and laneLabel: known lanes get names, unknown ids pass through', async () => {
  const { laneRows, laneLabel } = await importCore();
  const report = { byLane: [
    { lane: 'pr-review', tokens: 100, costUSD: 4.2, sessions: 2 },
    { lane: 'other', tokens: 10, costUSD: 0.5, sessions: 1 },
  ] };
  assert.deepEqual(laneRows(report).map((row) => row.lane), ['pr-review', 'other']);
  assert.deepEqual(laneRows({ byLane: null }), []);
  assert.deepEqual(laneRows({}), []);
  assert.deepEqual(laneRows(null), []);
  assert.equal(laneLabel('pr-review'), 'PR review');
  assert.equal(laneLabel('pack-distill'), 'Pack distiller');
  assert.equal(laneLabel('posthog'), 'PostHog');
  assert.equal(laneLabel('interactive'), 'Interactive');
  assert.equal(laneLabel('other'), 'Other');
  // A lane added server-side before this map knows about it still renders under its own id.
  assert.equal(laneLabel('some-new-lane'), 'some-new-lane');
  assert.equal(laneLabel(''), 'Other');
});

test('the lanes section stays hidden until a real automation lane has spend', async () => {
  const { hasLaneAttribution } = await importCore();
  // A fresh install: only the operator's own sessions, so the section would just restate the totals.
  assert.equal(hasLaneAttribution({ byLane: [{ lane: 'interactive', tokens: 1, costUSD: 1, sessions: 1 }] }), false);
  assert.equal(hasLaneAttribution({ byLane: [
    { lane: 'interactive', tokens: 1, costUSD: 1, sessions: 1 },
    { lane: 'other', tokens: 1, costUSD: 1, sessions: 1 },
  ] }), false);
  // One automation lane is enough to make the split worth showing.
  assert.equal(hasLaneAttribution({ byLane: [
    { lane: 'interactive', tokens: 1, costUSD: 1, sessions: 1 },
    { lane: 'pr-review', tokens: 1, costUSD: 1, sessions: 1 },
  ] }), true);
  assert.equal(hasLaneAttribution({ byLane: [] }), false);
  assert.equal(hasLaneAttribution(null), false);
});

test('laneSessionsText and the scope hint say what is and is not counted', async () => {
  const { laneSessionsText, LANE_SCOPE_HINT } = await importCore();
  assert.equal(laneSessionsText(1), '1 session');
  assert.equal(laneSessionsText(4), '4 sessions');
  assert.equal(laneSessionsText(1234), '1,234 sessions');
  assert.equal(laneSessionsText(0), '');
  assert.equal(laneSessionsText(null), '');
  // The hint has to name the boundary, since a terminal session's spend appears here as `other`.
  assert.match(LANE_SCOPE_HINT, /spawned by Glissa/);
  assert.match(LANE_SCOPE_HINT, /other/);
  for (const glyph of [String.fromCharCode(0x2014), String.fromCharCode(0x2013), String.fromCharCode(0x2026)]) {
    assert.equal(LANE_SCOPE_HINT.includes(glyph), false);
  }
});
