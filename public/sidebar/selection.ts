import { uiState } from '../ui-state-core.ts';

export function getSelectedId() {
  return uiState.snapshot().selectedSessionId;
}

export function setSelectedId(id: string | null) {
  uiState.dispatch('selectSession', id);
}

export function onSelectionChange(fn: (selectedSessionId: string | null) => void) {
  return uiState.subscribe((state, changedKeys) => {
    if (!changedKeys.includes('selectedSessionId')) return;
    fn(state.selectedSessionId);
  });
}
