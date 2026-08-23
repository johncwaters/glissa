'use strict';

/*
 * Backpressure policy for the CONTROL WebSocket, the mirror of what ws-sender.js does for the data
 * stream. The gap it closes (2026-08 review, section 1): control broadcasts called `client.send`
 * raw, ignoring bufferedAmount, so a suspended or slow dashboard accumulated health, usage, ingest,
 * lane and notification frames in server memory without limit.
 *
 * The two streams need OPPOSITE loss policies, which is exactly why they are two sockets. Data bytes
 * drop recoverably from the ring and backfill by offset. Control JSON must not drop: one-shot types
 * are replayed from the seq log on reconnect, and everything else is repaired by the connect
 * snapshot. So the policy here is not "drop when busy" but "drop only what the NEXT push repairs".
 *
 * Three classes:
 *   refreshable - periodic pushes whose successor carries the whole truth again (health telemetry,
 *                 usage rollups, plan limits, ingest activity). Dropping one of these while a socket
 *                 is backed up costs nothing: the next one is along in seconds and says everything.
 *   critical    - the one-shot types the replay log retains (notify, session-error, post-turn-result)
 *                 and the moments nothing repairs (a budget alert). Never dropped.
 *   normal      - deltas the connect snapshot repairs but nothing re-sends while connected (state
 *                 changes, diffs, renames). Not dropped either: a stale card is a bug the operator
 *                 sees, and the high-water mark exists to bound memory, not to trim correctness.
 *
 * Past the hard ceiling the socket is not slow, it is gone: closing it is what makes the client
 * reconnect and repair itself from a snapshot, and what stops an unbounded buffer.
 */

const { isReplayable } = require('../control-replay-core');

// Every type here must satisfy one rule: its successor makes its loss invisible. Adding a type that
// does not is how a dashboard silently goes stale under load.
const REFRESHABLE_TYPES = new Set([
  'health-snapshot',
  'usage-sessions',
  'usage-report',
  'plan-limits',
  'ingest-activity',
  'ingest-snapshot',
  'pr-status',
  'posthog-status',
]);

const DEFAULT_HIGH_WATER_MARK = 1 * 1024 * 1024;
const DEFAULT_HARD_CEILING = 8 * 1024 * 1024;

function classifyControlMessage(type) {
  if (isReplayable(type)) return 'critical';
  if (REFRESHABLE_TYPES.has(type)) return 'refreshable';
  return 'normal';
}

/**
 * @param {object} args
 * @param {number} args.bufferedAmount the socket's currently queued bytes
 * @param {string} args.type the control message type
 * @returns {{ action: 'send'|'drop'|'close', reason: string|null }}
 */
function decideControlSend({
  bufferedAmount,
  type,
  highWaterMark = DEFAULT_HIGH_WATER_MARK,
  hardCeiling = DEFAULT_HARD_CEILING,
}) {
  const buffered = Number.isFinite(bufferedAmount) ? bufferedAmount : 0;
  if (buffered >= hardCeiling) return { action: 'close', reason: 'ceiling' };
  if (buffered < highWaterMark) return { action: 'send', reason: null };
  if (classifyControlMessage(type) === 'refreshable') return { action: 'drop', reason: 'backpressure' };
  return { action: 'send', reason: null };
}

module.exports = {
  classifyControlMessage,
  decideControlSend,
  REFRESHABLE_TYPES,
  DEFAULT_HIGH_WATER_MARK,
  DEFAULT_HARD_CEILING,
};
