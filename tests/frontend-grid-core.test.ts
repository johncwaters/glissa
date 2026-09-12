import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWER_MAX_COLS,
  VIEWER_MAX_ROWS,
} from '../shared/contracts/data-messages.ts';
import type { DataFrameState, GridDecisionInput } from '../public/session-card/grid-core.ts';
import { decideGridActions, decideGridEngagementEdge, isFollowingGrid, isViewerEngaged, readDataFrame } from '../public/session-card/grid-core.ts';

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
  assert.equal(actions.owedClaim, null);
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
  assert.deepEqual(actions.owedClaim, { cols: 100, rows: 30 });
  assert.equal(actions.keepsPendingSettle, false);
  assert.equal(actions.sendUnview, false);
});

test('a repeated identical proposal does not re-claim', () => {
  const actions = decide({
    isActiveViewer: true,
    proposal: { cols: 100, rows: 30 },
    lastClaim: { cols: 100, rows: 30 },
  });
  assert.equal(actions.owedClaim, null);
});

test('a viewer that cannot send still owes the claim its own box measured', () => {
  const movedMeasurement = decide({
    isActiveViewer: true,
    isDataWsOpen: false,
    proposal: { cols: 100, rows: 31 },
    lastClaim: { cols: 100, rows: 30 },
  });
  assert.deepEqual(movedMeasurement.owedClaim, { cols: 100, rows: 31 });
  assert.equal(movedMeasurement.keepsPendingSettle, false);
});

test('a viewer following the pty still resizes to the grid the pty took', () => {
  const actions = decide({
    isActiveViewer: true,
    authoritative: { cols: 120, rows: 40 },
    applied: { cols: 80, rows: 24 },
  });
  assert.deepEqual(actions.resizeTo, { cols: 120, rows: 40 });
  assert.equal(actions.isFollowing, true);
});

test('a measurement that cannot be taken keeps a pending claim instead of destroying it', () => {
  const blind = decide({ isActiveViewer: true, proposal: null, lastClaim: { cols: 100, rows: 30 } });
  assert.equal(blind.owedClaim, null);
  assert.equal(blind.keepsPendingSettle, true);
  const zeroSized = decide({ isActiveViewer: true, proposal: { cols: 0, rows: 0 }, lastClaim: { cols: 100, rows: 30 } });
  assert.equal(zeroSized.keepsPendingSettle, true);
});

test('a claim the pty already holds owes nothing and drops any pending settle', () => {
  const owned = { cols: 100, rows: 30 };
  const settled = decide({ isActiveViewer: true, proposal: owned, lastClaim: owned });
  assert.equal(settled.owedClaim, null);
  assert.equal(settled.keepsPendingSettle, false);
});

test('a viewer that stopped viewing owes nothing and cancels its settle', () => {
  const departed = decide({ isActiveViewer: false, proposal: { cols: 100, rows: 30 }, lastClaim: { cols: 100, rows: 30 } });
  assert.equal(departed.owedClaim, null);
  assert.equal(departed.keepsPendingSettle, false);
  assert.equal(departed.sendUnview, true);
});

test('a hidden document is never engaged, however the card holds focus', () => {
  assert.equal(
    isViewerEngaged({
      isDocumentVisible: false,
      isDocumentFocused: true,
      hasFocusInsideCard: true,
      hasWindowBlurredSinceFocus: false,
    }),
    false,
  );
  assert.equal(
    isViewerEngaged({
      isDocumentVisible: false,
      isDocumentFocused: false,
      hasFocusInsideCard: false,
      hasWindowBlurredSinceFocus: false,
    }),
    false,
  );
  assert.equal(
    isViewerEngaged({
      isDocumentVisible: false,
      isDocumentFocused: false,
      hasFocusInsideCard: true,
      hasWindowBlurredSinceFocus: true,
    }),
    false,
  );
});

test('a visible document with focus inside the card is engaged even when the window reports no focus', () => {
  assert.equal(
    isViewerEngaged({
      isDocumentVisible: true,
      isDocumentFocused: false,
      hasFocusInsideCard: true,
      hasWindowBlurredSinceFocus: false,
    }),
    true,
  );
  assert.equal(
    isViewerEngaged({
      isDocumentVisible: true,
      isDocumentFocused: true,
      hasFocusInsideCard: false,
      hasWindowBlurredSinceFocus: false,
    }),
    true,
  );
  assert.equal(
    isViewerEngaged({
      isDocumentVisible: true,
      isDocumentFocused: false,
      hasFocusInsideCard: false,
      hasWindowBlurredSinceFocus: false,
    }),
    false,
  );
});

test('a card still holding focus after a window blur is not engaged', () => {
  assert.equal(
    isViewerEngaged({
      isDocumentVisible: true,
      isDocumentFocused: false,
      hasFocusInsideCard: true,
      hasWindowBlurredSinceFocus: true,
    }),
    false,
  );
});

test('focus landing inside the card again after a window blur restores engagement', () => {
  assert.equal(
    isViewerEngaged({
      isDocumentVisible: true,
      isDocumentFocused: false,
      hasFocusInsideCard: true,
      hasWindowBlurredSinceFocus: false,
    }),
    true,
  );
});

test('a window that says it holds focus is engaged whatever the stale blur flag says', () => {
  assert.equal(
    isViewerEngaged({
      isDocumentVisible: true,
      isDocumentFocused: true,
      hasFocusInsideCard: true,
      hasWindowBlurredSinceFocus: true,
    }),
    true,
  );
});

test('an engagement edge re-bids for a following viewer and only re-syncs the exact owner', () => {
  const followingViewer = {
    authoritative: { cols: 120, rows: 40 },
    lastClaim: { cols: 80, rows: 24 },
    isActiveViewer: true,
    isDocumentEngaged: true,
    isDataWsOpen: true,
  };
  assert.equal(decideGridEngagementEdge(followingViewer), 'rebid');
  assert.equal(decideGridEngagementEdge({ ...followingViewer, lastClaim: { cols: 120, rows: 40 } }), 'resync');
});

test('an engagement edge asks nothing of a viewer that cannot bid', () => {
  const followingViewer = {
    authoritative: { cols: 120, rows: 40 },
    lastClaim: { cols: 80, rows: 24 },
    isActiveViewer: true,
    isDocumentEngaged: true,
    isDataWsOpen: true,
  };
  assert.equal(decideGridEngagementEdge({ ...followingViewer, isActiveViewer: false }), 'none');
  assert.equal(decideGridEngagementEdge({ ...followingViewer, isDocumentEngaged: false }), 'none');
  assert.equal(decideGridEngagementEdge({ ...followingViewer, isDataWsOpen: false }), 'none');
});

test('the exact owner re-syncing on an engagement edge claims only a measurement that moved', () => {
  const owned = { cols: 100, rows: 30 };
  const unmoved = decide({
    isActiveViewer: true,
    authoritative: owned,
    lastClaim: owned,
    proposal: owned,
  });
  assert.equal(unmoved.owedClaim, null);
  const moved = decide({
    isActiveViewer: true,
    authoritative: owned,
    lastClaim: owned,
    proposal: { cols: 100, rows: 28 },
  });
  assert.deepEqual(moved.owedClaim, { cols: 100, rows: 28 });
});

test('a proposal changing on one axis re-claims', () => {
  const actions = decide({
    isActiveViewer: true,
    proposal: { cols: 100, rows: 31 },
    lastClaim: { cols: 100, rows: 30 },
  });
  assert.deepEqual(actions.owedClaim, { cols: 100, rows: 31 });
});

test('a NaN proposal claims nothing', () => {
  const actions = decide({ isActiveViewer: true, proposal: { cols: Number.NaN, rows: Number.NaN } });
  assert.equal(actions.owedClaim, null);
  assert.equal(actions.sendUnview, false);
});

test('a zero or negative proposal claims nothing', () => {
  assert.equal(decide({ isActiveViewer: true, proposal: { cols: 0, rows: 24 } }).owedClaim, null);
  assert.equal(decide({ isActiveViewer: true, proposal: { cols: 80, rows: -1 } }).owedClaim, null);
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

test('a closed socket owes its claim, unviews nothing, and still resizes', () => {
  const claimant = decide({
    isDataWsOpen: false,
    isActiveViewer: true,
    proposal: { cols: 100, rows: 30 },
    authoritative: { cols: 120, rows: 40 },
  });
  assert.deepEqual(claimant.owedClaim, { cols: 100, rows: 30 });
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
  assert.deepEqual(actions.owedClaim, { cols: VIEWER_MAX_COLS, rows: VIEWER_MAX_ROWS });
});

test('a proposal exactly at the contract bound claims unchanged', () => {
  const actions = decide({
    isActiveViewer: true,
    proposal: { cols: VIEWER_MAX_COLS, rows: VIEWER_MAX_ROWS },
  });
  assert.deepEqual(actions.owedClaim, { cols: VIEWER_MAX_COLS, rows: VIEWER_MAX_ROWS });
});

test('a viewer whose clamped claim is already the last claim does not re-claim', () => {
  const actions = decide({
    isActiveViewer: true,
    proposal: { cols: VIEWER_MAX_COLS + 110, rows: VIEWER_MAX_ROWS + 40 },
    lastClaim: { cols: VIEWER_MAX_COLS, rows: VIEWER_MAX_ROWS },
  });
  assert.equal(actions.owedClaim, null);
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
