import {
  VIEWER_MAX_COLS,
  VIEWER_MAX_ROWS,
  VIEWER_MIN_COLS,
  VIEWER_MIN_ROWS,
} from '../../shared/contracts/data-messages.ts';

export interface ViewerSizeRecord {
  cols: number;
  rows: number;
  resizeSeq: number;
}

export interface SessionSize {
  cols: number;
  rows: number;
}

export interface ResolvedSessionSize extends SessionSize {
  changed: boolean;
}

function isApplicableViewerSize(cols: unknown, rows: unknown): boolean {
  if (typeof cols !== 'number' || typeof rows !== 'number') return false;
  return Number.isInteger(cols) && Number.isInteger(rows)
    && cols >= VIEWER_MIN_COLS && cols <= VIEWER_MAX_COLS
    && rows >= VIEWER_MIN_ROWS && rows <= VIEWER_MAX_ROWS;
}

function pickSizeAfterDeparture<Key>(
  viewers: Iterable<[Key, ViewerSizeRecord | null | undefined]>,
  departingKey?: Key,
): SessionSize | null {
  let winner: ViewerSizeRecord | null = null;
  for (const [key, record] of viewers) {
    if (key === departingKey) continue;
    if (!record) continue;
    if (!isApplicableViewerSize(record.cols, record.rows)) continue;
    if (winner && record.resizeSeq <= winner.resizeSeq) continue;
    winner = record;
  }
  if (!winner) return null;
  return { cols: winner.cols, rows: winner.rows };
}

function resolveSessionSize<Key>({ viewers, departingKey, current }: {
  viewers: Iterable<[Key, ViewerSizeRecord | null | undefined]>;
  departingKey?: Key;
  current: SessionSize;
}): ResolvedSessionSize {
  const claimant = pickSizeAfterDeparture(viewers, departingKey);
  if (!claimant) return { cols: current.cols, rows: current.rows, changed: false };
  const changed = claimant.cols !== current.cols || claimant.rows !== current.rows;
  return { cols: claimant.cols, rows: claimant.rows, changed };
}

export { isApplicableViewerSize, pickSizeAfterDeparture, resolveSessionSize };
