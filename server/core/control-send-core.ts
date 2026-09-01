import { isReplayable } from '../control-replay-core.ts';

export type ControlMessageClass = 'critical' | 'refreshable' | 'normal';
export type ControlSendAction = 'send' | 'drop' | 'close';

export interface ControlSendDecision {
  action: ControlSendAction;
  reason: string | null;
}

const REFRESHABLE_TYPES = new Set([
  'health-snapshot',
  'usage-sessions',
  'plan-limits',
  'ingest-activity',
  'ingest-snapshot',
  'pr-status',
  'posthog-status',
]);

const DEFAULT_HIGH_WATER_MARK = 1 * 1024 * 1024;
const DEFAULT_HARD_CEILING = 8 * 1024 * 1024;

function classifyControlMessage(type: string): ControlMessageClass {
  if (isReplayable(type)) return 'critical';
  if (REFRESHABLE_TYPES.has(type)) return 'refreshable';
  return 'normal';
}

function decideControlSend({
  bufferedAmount,
  type,
  highWaterMark = DEFAULT_HIGH_WATER_MARK,
  hardCeiling = DEFAULT_HARD_CEILING,
}: {
  bufferedAmount?: unknown;
  type: string;
  highWaterMark?: number;
  hardCeiling?: number;
}): ControlSendDecision {
  const buffered = typeof bufferedAmount === 'number' && Number.isFinite(bufferedAmount) ? bufferedAmount : 0;
  if (buffered >= hardCeiling) return { action: 'close', reason: 'ceiling' };
  if (buffered < highWaterMark) return { action: 'send', reason: null };
  if (classifyControlMessage(type) === 'refreshable') return { action: 'drop', reason: 'backpressure' };
  return { action: 'send', reason: null };
}

export {
  classifyControlMessage,
  decideControlSend,
  REFRESHABLE_TYPES,
  DEFAULT_HIGH_WATER_MARK,
  DEFAULT_HARD_CEILING,
};
