// Single source of truth for "which session the review sidebar is showing". One selected id, shared
// across the Sessions grid (click a session name) and the Focus view (focus a rail pill), so there is
// never a competing notion of selection. Subscribers (the sidebar) re-render on change.

let _selectedId = null;
const _subs = new Set();

export function getSelectedId() {
  return _selectedId;
}

export function setSelectedId(id) {
  const next = id || null;
  if (next === _selectedId) return;
  _selectedId = next;
  for (const fn of _subs) {
    try { fn(_selectedId); } catch { /* a subscriber error must not break selection */ }
  }
}

export function onSelectionChange(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}
