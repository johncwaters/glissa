// Pure roster ordering + attention-queue cursor for the focus rail. Order is identity-based,
// never status-based: non-dormant sessions first, then alphabetical by name (numeric,
// case-insensitive). A state change never reorders a pill, so the operator keeps a stable
// spatial map of the rail; attention is carried by the pill treatment and the Alt+W jump,
// not by reordering. pickNextAttention walks an already-ordered attention queue (built by the
// caller from this same order) so Alt+W advances top-to-bottom and wraps around.

export function orderRoster(list) {
  return [...list].sort((a, b) =>
    (a.isDormant === b.isDormant ? 0 : a.isDormant ? 1 : -1)
    || String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
}

// Round-robin the next id after currentId. Empty queue -> null; currentId absent (or null)
// starts at the front; a single-element queue stays put. Pure: indices only, no DOM.
export function pickNextAttention(orderedIds, currentId) {
  if (!orderedIds.length) return null;
  const i = orderedIds.indexOf(currentId);
  return orderedIds[(i + 1) % orderedIds.length];
}
