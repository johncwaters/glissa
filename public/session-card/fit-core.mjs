// `redraw` only on a CHANGED grid (stale buffer only the PTY nudge can repaint); an unchanged grid must
// never ask, the nudge reflows the whole TUI, and an unmeasured fit (hidden card, default grid) publishes
// nothing or it resizes the PTY to a size no viewer sees. Pinned by tests/frontend-fit-core.test.js.

export function decideFitAction({
  measured,
  cols,
  rows,
  lastFittedCols,
  lastFittedRows,
  lastSentCols,
  lastSentRows,
}) {
  if (!measured) return { repaint: false, send: false, redraw: false };
  if (cols !== lastFittedCols || rows !== lastFittedRows) {
    return { repaint: true, send: true, redraw: true };
  }
  if (cols === lastSentCols && rows === lastSentRows) {
    return { repaint: false, send: false, redraw: false };
  }
  return { repaint: false, send: true, redraw: false };
}
