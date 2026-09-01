const MIN_COLS = 1;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 200;

export interface ViewerSizeRecord {
  cols: number;
  rows: number;
  resizeSeq: number;
}

function isApplicableViewerSize(cols: unknown, rows: unknown): boolean {
  if (typeof cols !== 'number' || typeof rows !== 'number') return false;
  return Number.isInteger(cols) && Number.isInteger(rows)
    && cols >= MIN_COLS && cols <= MAX_COLS
    && rows >= MIN_ROWS && rows <= MAX_ROWS;
}

function pickSizeAfterDeparture<Key>(
  viewers: Iterable<[Key, ViewerSizeRecord | null | undefined]>,
  departingKey?: Key,
): { cols: number; rows: number } | null {
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

export { isApplicableViewerSize, pickSizeAfterDeparture };
