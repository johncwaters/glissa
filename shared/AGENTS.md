<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-15 | Updated: 2026-03-21 -->

# shared/ — Shared State Constants

## Purpose

Single source of truth for session and notification state definitions used by both server (CommonJS) and browser (ES modules). Dual-format session states avoid transpilation while keeping constants in sync.

## Key Files

| File | Description |
|------|-------------|
| `states.js` | Session state constants (CJS) — `require('./shared/states')` on server. Exports `STATES`, `BADGE_LABELS`, `KILLABLE_STATES`, `RESTARTABLE_STATES` |
| `states.esm.js` | Session state constants (ESM) — imported in browser via Vite alias (`/shared/states.mjs`). Identical constants as named exports |
| `notification-states.js` | Notification lifecycle state machine (CJS only). Exports `NOTIFICATION_STATES` (IDLE, PENDING, DELIVERED, ESCALATED, ACKNOWLEDGED) and `NOTIFICATION_TRANSITIONS` table |

## For AI Agents

### Working In This Directory

**`states.js` and `states.esm.js` must stay in sync.** When adding/modifying session states, update both files.

The session state files are intentionally duplicated rather than auto-generated because:
- Server requires CommonJS (`module.exports`)
- Browser requires ESM (`export const`)
- No build step or transpiler in the project

`notification-states.js` is CJS-only (server-side consumer only: `notification-manager.js`).

### How Each File Is Consumed

| File | Consumer | Import Path |
|------|----------|-------------|
| `states.js` | `sessions.js`, `backend.js` (server) | `require('./shared/states')` |
| `states.esm.js` | `session-card.js`, `app.js` (browser) | `import { STATES } from '/shared/states.mjs'` via Vite alias in `vite.config.js` |
| `states.js` | `backend.js` mountDevRoutes | Dynamically served as ESM at `GET /shared/states.mjs` (production without dist/) |
| `notification-states.js` | `notification-manager.js`, `test-notification-manager.js` | `require('./shared/notification-states')` |

### Session State Constants

```javascript
STATES: { INITIALIZING, STARTING, RUNNING, WAITING, IDLE, COMPLETE, DONE, FAILED }
BADGE_LABELS: { [state]: 'Human-readable label' }
KILLABLE_STATES: [RUNNING, WAITING, IDLE, COMPLETE]
RESTARTABLE_STATES: [DONE, FAILED]
```

### Notification State Constants

```javascript
NOTIFICATION_STATES: { IDLE, PENDING, DELIVERED, ESCALATED, ACKNOWLEDGED }
NOTIFICATION_TRANSITIONS: { [state]: { [event]: nextState } }
```

PENDING is transient (auto-transitions in entry hook — never externally observable). DELIVERED and ESCALATED ping-pong via `escalation_tick` events to ensure entry/exit hooks fire each cycle.

### Testing Requirements

No dedicated tests for session states. `test-notification-manager.js` in the project root exercises the notification state machine.

## Dependencies

### Internal
None — these are leaf modules with no imports.

<!-- MANUAL: -->
