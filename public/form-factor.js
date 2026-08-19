// IO shell over form-factor-core.mjs. The stamp is live, not boot-only: a phone rotated past 768px
// genuinely becomes the desktop layout, and the subscribers are what let the app hand the borrowed card,
// sidebar and Radar panel across that flip instead of stranding them in a hidden subtree.

import { COARSE_POINTER_QUERY, decideLayout, PHONE_NARROW_QUERY } from './form-factor-core.mjs';

const coarsePointerQuery = window.matchMedia?.(COARSE_POINTER_QUERY);
const narrowWidthQuery = window.matchMedia?.(PHONE_NARROW_QUERY);

let currentLayout = 'desktop';
const layoutSubscribers = new Set();

function evaluateLayout() {
  return decideLayout({
    coarse: !!coarsePointerQuery?.matches,
    narrowWidth: !!narrowWidthQuery?.matches,
  });
}

function applyLayout(next) {
  if (next === currentLayout) return;
  currentLayout = next;
  document.documentElement.dataset.layout = next;
  for (const notify of layoutSubscribers) {
    // One bad subscriber must not strand the app half-way through a layout flip.
    try { notify(next); } catch { /* ignore */ }
  }
}

// Stamp the initial layout and start listening. Call once at boot, BEFORE anything reads getLayout().
export function initFormFactor() {
  currentLayout = evaluateLayout();
  document.documentElement.dataset.layout = currentLayout;
  const reevaluate = () => applyLayout(evaluateLayout());
  coarsePointerQuery?.addEventListener?.('change', reevaluate);
  narrowWidthQuery?.addEventListener?.('change', reevaluate);
  return currentLayout;
}

export function getLayout() {
  return currentLayout;
}

export function isPhoneLayout() {
  return currentLayout === 'phone';
}

// Subscribe to layout flips. Returns an unsubscribe function; the callback receives the NEW layout and
// fires only on an actual change, never on the initial evaluation.
export function onLayoutChange(notify) {
  layoutSubscribers.add(notify);
  return () => layoutSubscribers.delete(notify);
}
