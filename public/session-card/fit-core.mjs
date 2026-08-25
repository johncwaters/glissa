// A hidden terminal must neither connect nor publish its default grid because replay must follow a visible fit.

export function decideFitAction({
  measured,
  cols,
  rows,
  lastFittedCols,
  lastFittedRows,
  lastSentCols,
  lastSentRows,
  hasDataSocket,
  isDataSocketOpen,
  repaintRequested = false,
}) {
  const noAction = { repaint: false, connect: false, send: false, redraw: false };
  if (!measured) return noAction;

  const gridChanged = cols !== lastFittedCols || rows !== lastFittedRows;
  const repaint = repaintRequested || gridChanged;
  const connect = !hasDataSocket;
  if (!isDataSocketOpen) return { repaint, connect, send: false, redraw: false };
  if (gridChanged) return { repaint, connect, send: true, redraw: true };
  if (cols === lastSentCols && rows === lastSentRows) {
    return { repaint, connect, send: false, redraw: false };
  }
  return { repaint, connect, send: true, redraw: false };
}
