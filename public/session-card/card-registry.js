// Shared-state owner for the session-card modules. This holds ONLY state that
// genuinely crosses module boundaries; cluster-local state stays in its own
// module (layout.js owns maximize/split state, drag-drop.js owns drag state).
//
// This module is the deepest dependency in the session-card graph: every feature
// module imports it, so ESM evaluates it first and the DOM singletons below are
// resolved before any card is created.

// One entry per session card: { term, fitAddon, webglAddon, dataWs, card, badge,
// nameEl, btnMinimize, btnMaximize, ...DOM refs..., currentState, sleeping,
// abortController, debugOverlay, debugOpen }. Keyed by the stable session id
// (UUID). The Map reference is const; only its contents mutate.
export const sessionUIs = new Map();

// Dashboard DOM singletons, resolved once at module-eval.
export const container = document.getElementById('sessions-container');
export const minimizedBar = document.getElementById('minimized-bar');
export const aggregateEl = document.getElementById('aggregate-status');

// Reorder-echo de-dup: sendReorder (drag-drop) marks a locally-initiated reorder
// so the server's echoing `sessions-reordered` (handled in lifecycle) is ignored
// exactly once instead of re-applying an order the DOM already has.
let _localReorderPending = false;
export function markLocalReorderPending() {
  _localReorderPending = true;
}
export function consumeLocalReorderPending() {
  const was = _localReorderPending;
  _localReorderPending = false;
  return was;
}
