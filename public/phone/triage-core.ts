
const ATTENTION_RANK: Readonly<Record<string, number>> = Object.freeze({
  WAITING: 0,
  FAILED: 1,
  COMPLETE: 2,
  RUNNING: 3,
});
const RESTING_RANK = 4;

function rankOf(state: unknown) {
  const rank = typeof state === 'string' ? ATTENTION_RANK[state] : undefined;
  return rank === undefined ? RESTING_RANK : rank;
}

export function orderSessionsForTriage<Row extends { state?: unknown }>(rows: readonly Row[] | null | undefined): Row[] {
  return [...(rows || [])]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rankOf(a.row?.state) - rankOf(b.row?.state) || a.index - b.index)
    .map((entry) => entry.row);
}

