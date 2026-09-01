// Single source of truth for "which session the review sidebar is showing". One selected id, shared
// across the Sessions grid (click a session name) and the Focus view (focus a rail pill), so there is
// never a competing notion of selection. The value lives in the cross-cutting UI store; these three
// functions are the sidebar's named view of it, so callers keep speaking selection, not store keys.

import { uiState } from '../ui-state-core.ts';

export function getSelectedId() {
  return uiState.snapshot().selectedSessionId;
}

export function setSelectedId(id) {
  uiState.dispatch('selectSession', id);
}

export function onSelectionChange(fn) {
  return uiState.subscribe((state, changedKeys) => {
    if (!changedKeys.includes('selectedSessionId')) return;
    fn(state.selectedSessionId);
  });
}
