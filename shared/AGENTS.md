<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# shared

## Purpose
State constants used by BOTH the CommonJS server and the ESM browser bundle. Single source of truth for session and notification lifecycle states.

## Key Files

| File | Description |
|------|-------------|
| `states.js` | Session states (CJS, server-side): DORMANT, INITIALIZING, STARTING, RUNNING, WAITING, IDLE, COMPLETE, DONE, FAILED; plus BADGE_LABELS, STATE_GLYPHS, and the KILLABLE / RESTARTABLE / MERGEABLE_LIVE state sets |
| `states.esm.js` | ESM mirror of `states.js` for the browser; Vite aliases `/shared/states.mjs` to it (and `backend.js` serves the same path in production) |
| `notification-states.js` | Notification lifecycle states (IDLE, PENDING, DELIVERED, ...) for `notification-manager.js`, table-driven like the session machine |

## For AI Agents

### Working In This Directory
- `states.js` and `states.esm.js` are maintained as a synchronized pair (same constants and sets, different module syntax); change both together.
- States are frozen string constants; transitions live in `session/core/state-machine.js` and `notification-manager.js`, never here.
- `MERGEABLE_LIVE_STATES` is the merge-as-you-go gate shared by server and review sidebar; do not let the two copies drift.

### Testing Requirements
- `tests/state-machine.test.js` and the notification tests exercise these constants; `npm test`.

## Dependencies

### Internal
- Consumed by `../sessions.js`, `../notification-manager.js`, `../control-handlers.js`, and the entire `public/` frontend.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
