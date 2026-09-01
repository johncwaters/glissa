'use strict';

// The activity feed's pure half (docs/plan-ingestion.md, M6): what a wire event normalizes to, how a
// batched delta merges into the standing list, how a snapshot replaces it, and the bound that keeps the
// rendered list from growing for as long as a tab is left open.

const test = require('node:test');
const assert = require('node:assert/strict');

// visions-view-core is ESM; dynamic-import it from this CJS test file.
const importCore = () => import('../public/visions-view-core.ts');

const NOW = 1700000000000;

function event(seq, overrides = {}) {
  return {
    source: 'terminal',
    kind: 'output',
    ts: NOW,
    seq,
    scope: { root: '/home/johnw/glissa', sessionId: 's1' },
    summary: `event ${seq}`,
    ...overrides,
  };
}

test('a wire event normalizes to the flat shape the rows render from', async () => {
  const { normalizeActivityEvent } = await importCore();
  const normalized = normalizeActivityEvent(event(7));
  assert.deepEqual(normalized, {
    seq: 7,
    source: 'terminal',
    kind: 'output',
    ts: NOW,
    summary: 'event 7',
    root: '/home/johnw/glissa',
    sessionId: 's1',
  });
});

test('an event with no seq or no summary is dropped rather than rendered as a blank row', async () => {
  const { eventsOfMessage, normalizeActivityEvent } = await importCore();
  assert.equal(normalizeActivityEvent({ summary: 'no seq' }), null);
  assert.equal(normalizeActivityEvent({ seq: 1, summary: '   ' }), null);
  assert.equal(normalizeActivityEvent(null), null);
  assert.deepEqual(eventsOfMessage({ events: [event(1), { seq: 2 }, null] }).map((e) => e.seq), [1]);
  assert.deepEqual(eventsOfMessage({}), []);
});

test('source labels are the short names the rows show, and an unknown source keeps its own name', async () => {
  const { activitySourceLabel } = await importCore();
  assert.equal(activitySourceLabel('terminal'), 'terminal');
  assert.equal(activitySourceLabel('agentLogs'), 'agent');
  assert.equal(activitySourceLabel('shellHistory'), 'shell');
  assert.equal(activitySourceLabel('fs'), 'files');
  assert.equal(activitySourceLabel('somethingNew'), 'somethingNew');
  assert.equal(activitySourceLabel(undefined), 'source');
});

test('activity age reads in seconds, because a terminal event is interesting for being recent', async () => {
  const { activityAgeText } = await importCore();
  assert.equal(activityAgeText(NOW, NOW), '0s ago');
  assert.equal(activityAgeText(NOW - 45000, NOW), '45s ago');
  assert.equal(activityAgeText(NOW - 90000, NOW), '1m ago');
  assert.equal(activityAgeText(NOW - 7200000, NOW), '2h ago');
  assert.equal(activityAgeText(NOW - 172800000, NOW), '2d ago');
  assert.equal(activityAgeText(0, NOW), '');
});

test('an event with no root is labelled machine, and one with a root shows its last segment', async () => {
  const { activityScopeText } = await importCore();
  assert.equal(activityScopeText({ root: null }), 'machine');
  assert.equal(activityScopeText({ root: '/home/johnw/glissa' }), 'glissa');
  assert.equal(activityScopeText({ root: 'C:\\Users\\johnw\\Projects\\glissa\\' }), 'glissa');
  assert.equal(activityScopeText({ root: 'glissa' }), 'glissa');
});

test('a delta merges into the standing list, newest first', async () => {
  const { applyActivityMessage } = await importCore();
  const first = applyActivityMessage([], { events: [event(1), event(2)] });
  assert.deepEqual(first.map((e) => e.seq), [2, 1]);
  const second = applyActivityMessage(first, { events: [event(4), event(3)] });
  assert.deepEqual(second.map((e) => e.seq), [4, 3, 2, 1]);
});

test('an event arriving twice is stored once: a snapshot and a delta can carry the same seq', async () => {
  const { applyActivityMessage, applyActivitySnapshot } = await importCore();
  const fromSnapshot = applyActivitySnapshot({ events: [event(1), event(2)] });
  const merged = applyActivityMessage(fromSnapshot, { events: [event(2, { summary: 'updated' }), event(3)] });
  assert.deepEqual(merged.map((e) => e.seq), [3, 2, 1]);
  assert.equal(merged.find((e) => e.seq === 2).summary, 'updated');
});

test('a delta with nothing in it leaves the standing list alone', async () => {
  const { applyActivityMessage } = await importCore();
  const standing = applyActivityMessage([], { events: [event(1)] });
  assert.deepEqual(applyActivityMessage(standing, { events: [], overflow: 40 }).map((e) => e.seq), [1]);
});

test('the rendered list is bounded, however long the tab is left open', async () => {
  const { MAX_RENDERED_ACTIVITY, applyActivityMessage, applyActivitySnapshot } = await importCore();
  assert.equal(MAX_RENDERED_ACTIVITY, 100);
  let list = [];
  for (let batch = 0; batch < 30; batch += 1) {
    const events = [];
    for (let index = 0; index < 50; index += 1) events.push(event(batch * 50 + index));
    list = applyActivityMessage(list, { events });
    assert.ok(list.length <= MAX_RENDERED_ACTIVITY, `list grew to ${list.length}`);
  }
  assert.equal(list.length, MAX_RENDERED_ACTIVITY);
  assert.equal(list[0].seq, 30 * 50 - 1, 'the newest events are the ones kept');

  const many = [];
  for (let index = 0; index < 400; index += 1) many.push(event(index));
  assert.equal(applyActivitySnapshot({ events: many }).length, MAX_RENDERED_ACTIVITY);
});

test('a snapshot REPLACES the list, so an event evicted while the tab was away disappears', async () => {
  const { applyActivityMessage, applyActivitySnapshot } = await importCore();
  const standing = applyActivityMessage([], { events: [event(1), event(2), event(3)] });
  assert.equal(standing.length, 3);
  assert.deepEqual(applyActivitySnapshot({ events: [event(3)] }).map((e) => e.seq), [3]);
});

test('overflow reads as a count of what was not shown, never as loss', async () => {
  const { activityOverflowCount, activityOverflowText } = await importCore();
  assert.equal(activityOverflowCount({ overflow: 12 }), 12);
  assert.equal(activityOverflowCount({ overflow: 0 }), 0);
  assert.equal(activityOverflowCount({ overflow: -3 }), 0);
  assert.equal(activityOverflowCount({}), 0);
  assert.equal(activityOverflowText(0), '');
  assert.equal(activityOverflowText(1), '1 more event not shown');
  assert.equal(activityOverflowText(12), '12 more events not shown');
});

test('the count line agrees on singular and plural, and an empty feed says so in words', async () => {
  const { INGEST_EMPTY_TEXT, activityCountText, hasActivity } = await importCore();
  assert.equal(activityCountText(0), '0 events');
  assert.equal(activityCountText(1), '1 event');
  assert.equal(activityCountText(7), '7 events');
  assert.ok(INGEST_EMPTY_TEXT.length > 0);
  assert.equal(hasActivity({ events: [event(1)] }), true);
  assert.equal(hasActivity({ events: [] }), false);
});
