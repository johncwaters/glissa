// Pure drag-drop geometry. Given cached card rects (`[{card, rect}]`), the
// pointer, the dragged source card, and the drop-zone placeholder, find the
// nearest card by center and whether to drop before or after it. The live cache
// + DOM wiring live in drag-drop.js; this is the testable core of findDropTarget.

export function closestCardByCenter(x, y, rects, sourceCard, dropZone) {
  let closest = null;
  let closestDist = Infinity;
  let sourceIdx = -1;
  let targetIdx = -1;

  for (let i = 0; i < rects.length; i++) {
    const { card, rect } = rects[i];
    if (card === sourceCard) { sourceIdx = i; continue; }
    if (card === dropZone) continue;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < closestDist) {
      closestDist = dist;
      closest = card;
      targetIdx = i;
    }
  }

  if (!closest) return { card: null, before: true };
  return { card: closest, before: sourceIdx > targetIdx };
}
