// ── Session card (barrel) ─────────────────────────────────────
// Re-exports the session-card public API from the focused modules under
// ./session-card/. Consumers (public/app.js, public/dialogs.js) import from here.
//
// The former ~1600-line monolith has been decomposed into the modules below; this
// barrel is all that remains of it. Optional follow-up (Option B): repoint app.js
// and dialogs.js directly at the owning modules and delete this file. It was kept
// as a thin shim because app.js was under concurrent edit during the refactor, so
// repointing it would have entangled that work with the decomposition commits.

export { handleDebugStateRefresh, handleDebugStateResponse } from './session-card/card-dom.js';
export { exitMaximizeMode, isMaximizeActive, setLayoutMode } from './session-card/layout.js';
export {
  applyState,
  applyTerminalSettings,
  createSessionCard,
  focusSessionCard,
  getSessionCount,
  handleSessionsReordered,
  hasSession,
  removeSessionCard,
  renameSessionCard,
  updateAggregateStatus,
} from './session-card/lifecycle.js';
export { countSessionsByName, suggestSessionName } from './session-card/naming.js';
export { reconnectDataWs } from './session-card/terminal.js';
export { showErrorToast } from './session-card/toast.js';
