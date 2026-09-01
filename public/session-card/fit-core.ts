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
}: {
  measured?: boolean;
  cols?: number;
  rows?: number;
  lastFittedCols?: number | null;
  lastFittedRows?: number | null;
  lastSentCols?: number | null;
  lastSentRows?: number | null;
  repaintRequested?: boolean;
}) {
  const noAction = { repaint: false, send: false };
  if (!measured) return noAction;

  const fittedGridChanged = cols !== lastFittedCols || rows !== lastFittedRows;
  const sentGridChanged = cols !== lastSentCols || rows !== lastSentRows;
  const repaint = repaintRequested || fittedGridChanged;
  const send = repaintRequested || sentGridChanged;
  return { repaint, send };
}
