// The one home for dashboard state that CROSSES panel boundaries. A panel's own view state (sorts,
// filters, scroll offsets, DOM refs) stays in the panel; only a value a second surface reads or writes
// belongs here, because a second copy of a shared value is how the desktop and phone layouts drift.
// Pure: no DOM, no timers, no storage, so node:test can drive it directly.

export const INITIAL_UI_STATE = Object.freeze({
  layout: 'desktop',
  activeView: 'focus',
  phoneScreen: null,
  focusedSessionId: null,
  selectedSessionId: null,
  borrowedCardId: null,
  clientTrust: null,
});

const asId = (value) => value || null;

// Every write goes through one of these, so the set of things that can move is readable in one place
// and a typo lands as a thrown unknown-action rather than a silent new field.
export const UI_ACTIONS = Object.freeze({
  setLayout: (layout) => ({ layout }),
  setActiveView: (activeView) => ({ activeView }),
  setPhoneScreen: (screenId) => ({ phoneScreen: asId(screenId) }),
  focusSession: (id) => ({ focusedSessionId: asId(id) }),
  selectSession: (id) => ({ selectedSessionId: asId(id) }),
  borrowCard: (id) => ({ borrowedCardId: asId(id) }),
  setClientTrust: (trust) => ({ clientTrust: trust || null }),
});

export function createUiStateStore(initialState) {
  let state = Object.freeze({ ...INITIAL_UI_STATE, ...initialState });
  const subscribers = new Set();

  function snapshot() {
    return state;
  }

  function subscribe(notify) {
    if (typeof notify !== 'function') return () => {};
    subscribers.add(notify);
    return () => subscribers.delete(notify);
  }

  function changedKeysIn(patch) {
    const changed = [];
    for (const key of Object.keys(patch)) {
      if (!(key in INITIAL_UI_STATE)) throw new Error(`ui-state: unknown key "${key}"`);
      if (!Object.is(state[key], patch[key])) changed.push(key);
    }
    return changed;
  }

  function dispatch(action, ...args) {
    const buildPatch = UI_ACTIONS[action];
    if (!buildPatch) throw new Error(`ui-state: unknown action "${action}"`);
    const patch = buildPatch(...args);
    const changedKeys = changedKeysIn(patch);
    if (changedKeys.length === 0) return state;

    const previousState = state;
    state = Object.freeze({ ...state, ...patch });
    for (const notify of subscribers) {
      // One throwing subscriber must never strand the rest of a layout flip half-applied.
      try { notify(state, changedKeys, previousState); } catch { /* ignore */ }
    }
    return state;
  }

  return { snapshot, subscribe, dispatch };
}

export const uiState = createUiStateStore();
