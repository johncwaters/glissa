<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-15 -->

# shared/ — Shared State Constants

## Purpose

Single source of truth for session state definitions used by both server (CommonJS) and browser (ES modules). Dual-format to avoid transpilation while keeping state constants in sync.

## Key Files

| File | Description |
|------|-------------|
| `states.js` | CommonJS format — `require('./shared/states')` on server. Exports `STATES`, `BADGE_LABELS`, `KILLABLE_STATES`, `RESTARTABLE_STATES`, `DISMISSABLE_STATES` |
| `states.esm.js` | ESM format — imported in browser via Vite alias (`/shared/states.mjs`). Identical constants as named exports |

## For AI Agents

### Working In This Directory

**Both files must stay in sync.** When adding/modifying states, update both `states.js` and `states.esm.js`.

The files are intentionally duplicated rather than auto-generated because:
- Server requires CommonJS (`module.exports`)
- Browser requires ESM (`export const`)
- No build step or transpiler in the project

### How Each File Is Consumed

| File | Consumer | Import Path |
|------|----------|-------------|
| `states.js` | `sessions.js`, `backend.js` (server) | `require('./shared/states')` |
| `states.esm.js` | `session-card.js` (browser) | `import { STATES } from '/shared/states.mjs'` via Vite alias in `vite.config.js` |
| `states.js` | `backend.js` mountDevRoutes | Dynamically served as ESM at `GET /shared/states.mjs` (production without dist/) |

### State Constants

```javascript
STATES: { INITIALIZING, STARTING, RUNNING, WAITING, IDLE, DONE, FAILED }
BADGE_LABELS: { [state]: 'Human-readable label' }
KILLABLE_STATES: [RUNNING, WAITING, IDLE]
RESTARTABLE_STATES: [DONE, FAILED]
DISMISSABLE_STATES: [WAITING]
```

### Testing Requirements

No dedicated tests. Verify state changes work end-to-end by running the server and checking dashboard badges.

## Dependencies

### Internal
None — this is a leaf module with no imports.

<!-- MANUAL: -->
