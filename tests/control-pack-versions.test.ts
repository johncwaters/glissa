// The connect snapshot carries the latest built version of every context pack, which is the baseline
// a dashboard compares each session's DELIVERED versions against. It rides the snapshot deliberately:
// a reconnecting client is repaired by that one frame, which is why the `pack-updated` broadcast needs
// no retention in the replay log. Booting a real backend for this would drag in the pack service's
// real fs watchers and builds, so this drives registerControlHandlers directly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createReplayLog } from '../server/control-replay-core.ts';
import type { ControlHandlerDeps } from '../server/control-handlers.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

interface SnapshotFrame {
  type: string;
  packVersions?: Record<string, string | null>;
  sessions?: unknown[];
}

function connect(extraDeps: Partial<ControlHandlerDeps> = {}): SnapshotFrame | undefined {
  const server = createControlServer(controlDeps({ projects: [] }, extraDeps));
  return connectControl<SnapshotFrame>(server).sent.find((msg) => msg.type === 'snapshot');
}

test('the snapshot carries the latest built pack versions', () => {
  const snapshot = connect({ getPackVersions: () => ({ 'house-rules': 'v2', 'crew-rules': 'v7' }) });
  assert.deepEqual(snapshot?.packVersions, { 'house-rules': 'v2', 'crew-rules': 'v7' });
});

test('a caller without the accessor still gets a snapshot, with no versions', () => {
  const snapshot = connect();
  assert.deepEqual(snapshot?.packVersions, {});
  assert.deepEqual(snapshot?.sessions, []);
});

test('pack-updated is not retained for replay: the snapshot already repairs it', () => {
  const log = createReplayLog();
  log.stamp({ type: 'pack-updated', name: 'crew-rules', version: 'v2' });
  log.stamp({ type: 'session-error', id: 'a', message: 'boom' });

  const { entries } = log.entriesSince(0);
  assert.deepEqual(entries.map((entry) => entry.type), ['session-error']);
});
