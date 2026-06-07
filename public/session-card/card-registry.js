// Shared-state owner for the session-card modules. This holds ONLY state that
// genuinely crosses module boundaries; cluster-local state stays in its own module.
//
// This module is the deepest dependency in the session-card graph: every feature
// module imports it, so ESM evaluates it first and the DOM singletons below are
// resolved before any card is created.

// One entry per session card: { term, fitAddon, webglAddon, dataWs, card, badge,
// nameEl, ...DOM refs..., currentState, abortController, debugOverlay, debugOpen }.
// Keyed by the stable session id (UUID). The Map reference is const; only its contents mutate.
export const sessionUIs = new Map();

// Dashboard DOM singletons, resolved once at module-eval.
export const container = document.getElementById('sessions-container');
export const aggregateEl = document.getElementById('aggregate-status');
