// The one home for dashboard state that CROSSES panel boundaries. A panel's own view state (sorts,
// filters, scroll offsets, DOM refs) stays in the panel; only a value a second surface reads or writes
// belongs here, because a second copy of a shared value is how the desktop and phone layouts drift.
// Pure: no DOM, no timers, no storage, so node:test can drive it directly.

export interface UiState {
  layout: string;
  activeView: string;
  phoneScreen: string | null;
  focusedSessionId: string | null;
  selectedSessionId: string | null;
  borrowedCardId: string | null;
}

export type UiStatePatch = Partial<UiState>;
export type UiStateSubscriber = (state: Readonly<UiState>, changedKeys: (keyof UiState)[], previousState: Readonly<UiState>) => void;

export const INITIAL_UI_STATE: Readonly<UiState> = Object.freeze({
  layout: 'desktop',
  activeView: 'focus',
  phoneScreen: null,
  focusedSessionId: null,
  selectedSessionId: null,
  borrowedCardId: null,
});

const asId = (value: string | null | undefined): string | null => value || null;

// Every write goes through one of these, so the set of things that can move is readable in one place
// and a typo lands as a thrown unknown-action rather than a silent new field.
export const UI_ACTIONS = Object.freeze({
  setLayout: (layout: string): UiStatePatch => ({ layout }),
  setActiveView: (activeView: string): UiStatePatch => ({ activeView }),
  setPhoneScreen: (screenId: string | null): UiStatePatch => ({ phoneScreen: asId(screenId) }),
  focusSession: (id: string | null): UiStatePatch => ({ focusedSessionId: asId(id) }),
  selectSession: (id: string | null): UiStatePatch => ({ selectedSessionId: asId(id) }),
  borrowCard: (id: string | null): UiStatePatch => ({ borrowedCardId: asId(id) }),
});

export type UiActionName = keyof typeof UI_ACTIONS;

export function createUiStateStore(initialState?: UiStatePatch) {
  let state: Readonly<UiState> = Object.freeze({ ...INITIAL_UI_STATE, ...initialState });
  const subscribers = new Set<UiStateSubscriber>();

  function snapshot() {
    return state;
  }

  function subscribe(notify: UiStateSubscriber) {
    if (typeof notify !== 'function') return () => {};
    subscribers.add(notify);
    return () => subscribers.delete(notify);
  }

  function changedKeysIn(patch: UiStatePatch) {
    const changed: (keyof UiState)[] = [];
    for (const key of Object.keys(patch) as (keyof UiState)[]) {
      if (!(key in INITIAL_UI_STATE)) throw new Error(`ui-state: unknown key "${key}"`);
      if (!Object.is(state[key], patch[key])) changed.push(key);
    }
    return changed;
  }

  function dispatch(action: UiActionName, value?: string | null) {
    const buildPatch = UI_ACTIONS[action];
    if (!buildPatch) throw new Error(`ui-state: unknown action "${action}"`);
    const patch = buildPatch(value as string);
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

export const getActiveView = () => uiState.snapshot().activeView;
