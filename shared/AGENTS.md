<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# shared

## Purpose
State constants used by BOTH the CommonJS server and the ESM browser bundle. Single source of truth for session and notification lifecycle states. The browser's `/shared/states.mjs` is GENERATED from `states.js` by `server/browser-modules.js`, the one renderer behind both the Vite plugin and the no-build server route, so there is no ESM twin to keep in sync.

## Key Files

| File | Description |
|------|-------------|
| `states.js` | Session states (CJS, server-side): DORMANT, INITIALIZING, STARTING, RUNNING, WAITING, IDLE, COMPLETE, DONE, FAILED; plus BADGE_LABELS, STATE_GLYPHS, and the KILLABLE / RESTARTABLE / MERGEABLE_LIVE state sets |
| `notification-states.js` | Notification lifecycle states (IDLE, PENDING, DELIVERED, ...) for `notification-manager.js`, table-driven like the session machine |
| `paths.js` | SERVER-ONLY (requires `node:fs`, never import it into the browser bundle): `isSameDirectoryPath` (do two spellings name one directory), `canonicalizePath` (the one spelling every producer agrees on), and `safePathSegment` (the Windows-legal single path segment a session id or name is sanitized into) |

## For AI Agents

### Working In This Directory
- `states.js` may export CONSTANTS only: `renderConstantsModule` serializes its exports with `JSON.stringify`, so a function or class added here would silently break the browser bundle.
- States are frozen string constants; transitions live in `session/core/state-machine.js` and `notification-manager.js`, never here.
- `MERGEABLE_LIVE_STATES` is the merge-as-you-go gate shared by server and review sidebar; do not let the two copies drift.
- Not everything here is browser-safe: `paths.js` touches the filesystem and is consumed only by server code. Keep new browser-facing constants in `states.js`.
- Any path handed to `fs.watch` goes through `canonicalizePath` first. libuv expands each reported event filename to its long form and asserts it still starts with the watched dir, so an 8.3 short path (a CI runner's `C:\Users\RUNNER~1\...` %TEMP%) ABORTS the process from native code, past every try/catch.

### Testing Requirements
- `tests/state-machine.test.js` and the notification tests exercise these constants; `npm test`.

## Dependencies

### Internal
- Consumed by `../sessions.js`, `../notification-manager.js`, `../control-handlers.js`, and the entire `public/` frontend.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
