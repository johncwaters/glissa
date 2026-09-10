import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWER_MAX_COLS,
  VIEWER_MAX_ROWS,
} from '../shared/contracts/data-messages.ts';
import type { DataFrameState, GridDecisionInput } from '../public/session-card/grid-core.ts';
import { decideGridActions, isFollowingGrid, readDataFrame } from '../public/session-card/grid-core.ts';

const IDLE_VIEWER: GridDecisionInput = {
  authoritative: null,
  applied: { cols: 80, rows: 24 },
  proposal: null,
  isActiveViewer: false,
  isDataWsOpen: true,
  lastClaim: null,
};

function decide(overrides: Partial<GridDecisionInput>) {
  return decideGridActions({ ...IDLE_VIEWER, ...overrides });
}

function binaryFrame(payload: unknown) {
  return new TextEncoder().encode(JSON.stringify(payload)).buffer;
}

function freshFrameState(): DataFrameState {
  return { hasSeenSize: false, lastSeq: 0 };
}

test('a follower resizes to the authoritative grid and claims nothing', () => {
  const actions = decide({ authoritative: { cols: 120, rows: 40 }, applied: { cols: 80, rows: 24 } });
  assert.deepEqual(actions.resizeTo, { cols: 120, rows: 40 });
  assert.equal(actions.claim, null);
  assert.equal(actions.isFollowing, true);
});

test('an authoritative size equal to the applied grid resizes nothing', () => {
  const actions = decide({ authoritative: { cols: 80, rows: 24 }, applied: { cols: 80, rows: 24 } });
  assert.equal(actions.resizeTo, null);
});

test('no authoritative size resizes nothing', () => {
  const actions = decide({ authoritative: null, applied: { cols: 80, rows: 24 } });
  assert.equal(actions.resizeTo, null);
});

test('the active viewer claims a valid proposal once', () => {
  const actions = decide({ isActiveViewer: true, proposal: { cols: 100, rows: 30 } });
  assert.deepEqual(actions.claim, { cols: 100, rows: 30 });
  assert.equal(actions.sendUnview, false);
});

test('a repeated identical proposal does not re-claim', () => {
  const actions = decide({
    isActiveViewer: true,
    proposal: { cols: 100, rows: 30 },
    lastClaim: { cols: 100, rows: 30 },
  });
  assert.equal(actions.claim, null);
});

test('a proposal changing on one axis re-claims', () => {
  const actions = decide({
    isActiveViewer: true,
    proposal: { cols: 100, rows: 31 },
    lastClaim: { cols: 100, rows: 30 },
  });
  assert.deepEqual(actions.claim, { cols: 100, rows: 31 });
});

test('a NaN proposal claims nothing', () => {
  const actions = decide({ isActiveViewer: true, proposal: { cols: Number.NaN, rows: Number.NaN } });
  assert.equal(actions.claim, null);
  assert.equal(actions.sendUnview, false);
});

test('a zero or negative proposal claims nothing', () => {
  assert.equal(decide({ isActiveViewer: true, proposal: { cols: 0, rows: 24 } }).claim, null);
  assert.equal(decide({ isActiveViewer: true, proposal: { cols: 80, rows: -1 } }).claim, null);
});

test('losing active-viewer status unviews exactly once', () => {
  const first = decide({ isActiveViewer: false, lastClaim: { cols: 100, rows: 30 } });
  assert.equal(first.sendUnview, true);
  const second = decide({ isActiveViewer: false, lastClaim: null });
  assert.equal(second.sendUnview, false);
});

test('a viewer that never claimed does not unview', () => {
  assert.equal(decide({ isActiveViewer: false, lastClaim: null }).sendUnview, false);
});

test('a closed socket neither claims nor unviews but still resizes', () => {
  const claimant = decide({
    isDataWsOpen: false,
    isActiveViewer: true,
    proposal: { cols: 100, rows: 30 },
    authoritative: { cols: 120, rows: 40 },
  });
  assert.equal(claimant.claim, null);
  assert.deepEqual(claimant.resizeTo, { cols: 120, rows: 40 });
  const departed = decide({ isDataWsOpen: false, isActiveViewer: false, lastClaim: { cols: 100, rows: 30 } });
  assert.equal(departed.sendUnview, false);
});

test('the claimant whose grid the pty took is not following', () => {
  const actions = decide({
    isActiveViewer: true,
    authoritative: { cols: 100, rows: 30 },
    lastClaim: { cols: 100, rows: 30 },
    proposal: { cols: 100, rows: 30 },
  });
  assert.equal(actions.isFollowing, false);
});

test('the first size frame of a connection is the attach', () => {
  const state = freshFrameState();
  const decision = readDataFrame(binaryFrame({ type: 'pty-size', cols: 120, rows: 40, seq: 7 }), state);
  assert.deepEqual(decision, { kind: 'attach-size', cols: 120, rows: 40, seq: 7 });
});

test('a later size frame resizes without resetting', () => {
  const state: DataFrameState = { hasSeenSize: true, lastSeq: 7 };
  const decision = readDataFrame(binaryFrame({ type: 'pty-size', cols: 90, rows: 20, seq: 8 }), state);
  assert.deepEqual(decision, { kind: 'size', cols: 90, rows: 20, seq: 8 });
});

test('a size frame with a stale seq is discarded', () => {
  const state: DataFrameState = { hasSeenSize: true, lastSeq: 8 };
  assert.deepEqual(readDataFrame(binaryFrame({ type: 'pty-size', cols: 90, rows: 20, seq: 8 }), state), { kind: 'stale' });
  assert.deepEqual(readDataFrame(binaryFrame({ type: 'pty-size', cols: 90, rows: 20, seq: 2 }), state), { kind: 'stale' });
});

test('a seq below the previous connection is the attach on a fresh connection', () => {
  const decision = readDataFrame(binaryFrame({ type: 'pty-size', cols: 90, rows: 20, seq: 1 }), freshFrameState());
  assert.deepEqual(decision, { kind: 'attach-size', cols: 90, rows: 20, seq: 1 });
});

test('a text frame is bytes', () => {
  const decision = readDataFrame('hello', { hasSeenSize: true, lastSeq: 3 });
  assert.deepEqual(decision, { kind: 'bytes', data: 'hello' });
});

test('a malformed binary frame is ignored', () => {
  const state = freshFrameState();
  assert.deepEqual(readDataFrame(binaryFrame({ type: 'pty-size', cols: 0, rows: 40, seq: 1 }), state), { kind: 'ignored' });
  assert.deepEqual(readDataFrame(binaryFrame({ type: 'nonsense' }), state), { kind: 'ignored' });
  assert.deepEqual(readDataFrame(new TextEncoder().encode('not json').buffer, state), { kind: 'ignored' });
});

test('a proposal past the contract maximum claims the maximum instead of being dropped', () => {
  const actions = decide({
    isActiveViewer: true,
    proposal: { cols: VIEWER_MAX_COLS + 110, rows: VIEWER_MAX_ROWS + 40 },
  });
  assert.deepEqual(actions.claim, { cols: VIEWER_MAX_COLS, rows: VIEWER_MAX_ROWS });
});

test('a proposal exactly at the contract bound claims unchanged', () => {
  const actions = decide({
    isActiveViewer: true,
    proposal: { cols: VIEWER_MAX_COLS, rows: VIEWER_MAX_ROWS },
  });
  assert.deepEqual(actions.claim, { cols: VIEWER_MAX_COLS, rows: VIEWER_MAX_ROWS });
});

test('a viewer whose clamped claim is already the last claim does not re-claim', () => {
  const actions = decide({
    isActiveViewer: true,
    proposal: { cols: VIEWER_MAX_COLS + 110, rows: VIEWER_MAX_ROWS + 40 },
    lastClaim: { cols: VIEWER_MAX_COLS, rows: VIEWER_MAX_ROWS },
  });
  assert.equal(actions.claim, null);
});

test('a viewer whose claim matches the pty grid reads as exact without waiting for an echo', () => {
  const authoritative = { cols: 100, rows: 30 };
  assert.equal(isFollowingGrid({ authoritative, isActiveViewer: true, lastClaim: authoritative }), false);
  assert.equal(
    isFollowingGrid({ authoritative, isActiveViewer: true, lastClaim: { cols: 80, rows: 24 } }),
    true,
    'a claim the pty has not taken yet still follows',
  );
  assert.equal(isFollowingGrid({ authoritative, isActiveViewer: false, lastClaim: authoritative }), true);
  assert.equal(isFollowingGrid({ authoritative: null, isActiveViewer: true, lastClaim: null }), true);
});
