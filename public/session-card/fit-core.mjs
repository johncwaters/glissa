// Hidden terminals may receive output, but only a visible measurement may publish viewer geometry.

export function decideFitAction({
  measured,
  cols,
  rows,
  lastFittedCols,
  lastFittedRows,
  lastSentCols,
  lastSentRows,
  repaintRequested = false,
}) {
  const noAction = { repaint: false, send: false };
  if (!measured) return noAction;

  const fittedGridChanged = cols !== lastFittedCols || rows !== lastFittedRows;
  const sentGridChanged = cols !== lastSentCols || rows !== lastSentRows;
  const repaint = repaintRequested || fittedGridChanged;
  const send = repaintRequested || sentGridChanged;
  return { repaint, send };
}
