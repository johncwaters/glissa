import {
  parsePtySizeFrame,
  VIEWER_MAX_COLS,
  VIEWER_MAX_ROWS,
  VIEWER_MIN_COLS,
  VIEWER_MIN_ROWS,
} from '#shared/contracts/data-messages.ts';
import type { PtySizeFrame } from '#shared/contracts/data-messages.ts';

export interface TerminalGrid {
  cols: number;
  rows: number;
}

export interface GridDecisionInput {
  authoritative: TerminalGrid | null;
  applied: TerminalGrid | null;
  proposal: TerminalGrid | null;
  isActiveViewer: boolean;
  isDataWsOpen: boolean;
  lastClaim: TerminalGrid | null;
}

export interface GridActions {
  resizeTo: TerminalGrid | null;
  claim: TerminalGrid | null;
  sendUnview: boolean;
  isFollowing: boolean;
}

export interface DataFrameState {
  hasSeenSize: boolean;
  lastSeq: number;
}

export type DataFrameDecision =
  | { kind: 'attach-size'; cols: number; rows: number; seq: number }
  | { kind: 'size'; cols: number; rows: number; seq: number }
  | { kind: 'bytes'; data: string }
  | { kind: 'stale' }
  | { kind: 'ignored' };

function isSameGrid(one: TerminalGrid | null, other: TerminalGrid | null): boolean {
  if (!one || !other) return false;
  return one.cols === other.cols && one.rows === other.rows;
}

function isUsableGrid(grid: TerminalGrid | null): grid is TerminalGrid {
  if (!grid) return false;
  if (!Number.isInteger(grid.cols) || !Number.isInteger(grid.rows)) return false;
  return grid.cols > 0 && grid.rows > 0;
}

export function clampGridToContract(grid: TerminalGrid): TerminalGrid {
  return {
    cols: Math.min(Math.max(grid.cols, VIEWER_MIN_COLS), VIEWER_MAX_COLS),
    rows: Math.min(Math.max(grid.rows, VIEWER_MIN_ROWS), VIEWER_MAX_ROWS),
  };
}

export function isFollowingGrid({
  authoritative,
  isActiveViewer,
  lastClaim,
}: Pick<GridDecisionInput, 'authoritative' | 'isActiveViewer' | 'lastClaim'>): boolean {
  return !(isActiveViewer && isSameGrid(authoritative, lastClaim));
}

export function decideGridActions({
  authoritative,
  applied,
  proposal,
  isActiveViewer,
  isDataWsOpen,
  lastClaim,
}: GridDecisionInput): GridActions {
  const needsResize = !!authoritative && !isSameGrid(authoritative, applied);
  const claimable = isUsableGrid(proposal) ? clampGridToContract(proposal) : null;
  const canClaim = isActiveViewer && isDataWsOpen && !!claimable && !isSameGrid(claimable, lastClaim);
  return {
    resizeTo: needsResize ? authoritative : null,
    claim: canClaim ? claimable : null,
    sendUnview: !isActiveViewer && isDataWsOpen && !!lastClaim,
    isFollowing: isFollowingGrid({ authoritative, isActiveViewer, lastClaim }),
  };
}

function textOfBinaryFrame(frame: unknown): string | null {
  if (frame instanceof ArrayBuffer) return new TextDecoder().decode(frame);
  if (ArrayBuffer.isView(frame)) return new TextDecoder().decode(frame);
  return null;
}

function sizeFrameOrNull(frame: unknown): PtySizeFrame | null {
  const text = textOfBinaryFrame(frame);
  if (text === null) return null;
  return parsePtySizeFrame(text);
}

export function readDataFrame(frame: unknown, state: DataFrameState): DataFrameDecision {
  if (typeof frame === 'string') return { kind: 'bytes', data: frame };
  const size = sizeFrameOrNull(frame);
  if (!size) return { kind: 'ignored' };
  if (!state.hasSeenSize) return { kind: 'attach-size', cols: size.cols, rows: size.rows, seq: size.seq };
  if (size.seq <= state.lastSeq) return { kind: 'stale' };
  return { kind: 'size', cols: size.cols, rows: size.rows, seq: size.seq };
}
