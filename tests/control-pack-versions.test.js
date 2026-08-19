'use strict';

// The connect snapshot carries the latest built version of every context pack, which is the baseline
// a dashboard compares each session's DELIVERED versions against. It rides the snapshot deliberately:
// a reconnecting client is repaired by that one frame, which is why the `pack-updated` broadcast needs
// no retention in the replay log. Booting a real backend for this would drag in the pack service's
// real fs watchers and builds, so this drives registerControlHandlers directly (the control-dispatch
// harness pattern).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerControlHandlers } = require('../server/control-handlers');
const { createReplayLog } = require('../server/control-replay-core');

function connect(extraDeps = {}) {
  const controlWss = new EventEmitter();
  const sent = [];
  const ws = { send: (raw) => sent.push(JSON.parse(raw)), on: () => {} };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [] },
    configStore: { save: (fn) => fn({ projects: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: () => {},
    ...extraDeps,
  });
  controlWss.emit('connection', ws);
  return sent.find((msg) => msg.type === 'snapshot');
}

test('the snapshot carries the latest built pack versions', () => {
  const snapshot = connect({ getPackVersions: () => ({ 'company-context': 'v2', glissa: 'v7' }) });
  assert.deepEqual(snapshot.packVersions, { 'company-context': 'v2', glissa: 'v7' });
});

test('a caller without the accessor still gets a snapshot, with no versions', () => {
  const snapshot = connect();
  assert.deepEqual(snapshot.packVersions, {});
  assert.deepEqual(snapshot.sessions, []);
});

test('pack-updated is not retained for replay: the snapshot already repairs it', () => {
  const log = createReplayLog();
  log.stamp({ type: 'pack-updated', name: 'glissa', version: 'v2' });
  log.stamp({ type: 'session-error', id: 'a', message: 'boom' });

  const { entries } = log.entriesSince(0);
  assert.deepEqual(entries.map((entry) => entry.type), ['session-error']);
});
