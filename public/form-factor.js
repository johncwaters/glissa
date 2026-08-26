// IO shell over form-factor-core.mjs. The stamp is live, not boot-only: a phone rotated past 768px
// genuinely becomes the desktop layout, and the subscribers are what let the app hand the borrowed card,
// sidebar and Radar panel across that flip instead of stranding them in a hidden subtree.
// The layout itself lives in the cross-cutting UI store; this module owns only the media queries,
// the <html data-layout> stamp and the named accessors.

import { COARSE_POINTER_QUERY, decideLayout, PHONE_NARROW_QUERY } from './form-factor-core.mjs';
import { uiState } from './ui-state-core.mjs';

const coarsePointerQuery = window.matchMedia?.(COARSE_POINTER_QUERY);
const narrowWidthQuery = window.matchMedia?.(PHONE_NARROW_QUERY);

function evaluateLayout() {
  return decideLayout({
    coarse: !!coarsePointerQuery?.matches,
    narrowWidth: !!narrowWidthQuery?.matches,
  });
}

function stampLayout(layout) {
  document.documentElement.dataset.layout = layout;
}

// Stamp the initial layout and start listening. Call once at boot, BEFORE anything reads the layout.
export function initFormFactor() {
  // Subscribed FIRST so the attribute is written ahead of every other layout subscriber: terminal.js
  // and touch-scroll.js read it straight off the element during the handoff those subscribers run.
  uiState.subscribe((state, changedKeys) => {
    if (!changedKeys.includes('layout')) return;
    stampLayout(state.layout);
  });

  const initialLayout = evaluateLayout();
  stampLayout(initialLayout);
  uiState.dispatch('setLayout', initialLayout);

  const reevaluate = () => uiState.dispatch('setLayout', evaluateLayout());
  coarsePointerQuery?.addEventListener?.('change', reevaluate);
  narrowWidthQuery?.addEventListener?.('change', reevaluate);
  return initialLayout;
}

export function isPhoneLayout() {
  return uiState.snapshot().layout === 'phone';
}

// Subscribe to layout flips. Returns an unsubscribe function; the callback receives the NEW layout and
// fires only on an actual change, never on the initial evaluation.
export function onLayoutChange(notify) {
  return uiState.subscribe((state, changedKeys) => {
    if (!changedKeys.includes('layout')) return;
    notify(state.layout);
  });
}
