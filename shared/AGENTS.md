<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# shared

## Purpose
TypeScript ESM modules used by BOTH the server and the browser bundle. Single source of truth for session and notification lifecycle states. The server imports them by relative `.ts` path; the browser imports them through the `#shared/*` package imports map and Vite bundles them. One module, no generated twin, no renderer.

## Key Files

| File | Description |
|------|-------------|
| `states.ts` | Session states: DORMANT, INITIALIZING, STARTING, RUNNING, WAITING, IDLE, COMPLETE, DONE, FAILED; plus BADGE_LABELS, STATE_GLYPHS, and the KILLABLE / RESTARTABLE / MERGEABLE_LIVE state sets |
| `notification-states.ts` | Notification lifecycle states (IDLE, PENDING, DELIVERED, ...) for `notification-manager.ts`, table-driven like the session machine |
| `paths.ts` | SERVER-ONLY (requires `node:fs`, never import it into the browser bundle): `isSameDirectoryPath` (do two spellings name one directory), `canonicalizePath` (the one spelling every producer agrees on), and `safePathSegment` (the Windows-legal single path segment a session id or name is sanitized into) |

## For AI Agents

### Working In This Directory
- States are frozen string constants; transitions live in `session/core/state-machine.ts` and `notification-manager.ts`, never here.
- `MERGEABLE_LIVE_STATES` is the merge-as-you-go gate shared by server and review sidebar; do not let the two copies drift.
- Not everything here is browser-safe: `paths.ts` touches the filesystem and is consumed only by server code. Keep new browser-facing constants in `states.ts`.
- Any path handed to `fs.watch` goes through `canonicalizePath` first. libuv expands each reported event filename to its long form and asserts it still starts with the watched dir, so an 8.3 short path (a CI runner's `C:\Users\RUNNER~1\...` %TEMP%) ABORTS the process from native code, past every try/catch.

### Testing Requirements
- `tests/state-machine.test.ts` and the notification tests exercise these constants; `npm test`.

## Dependencies

### Internal
- Consumed by `session/sessions.js`, `notifications/notification-manager.ts`, `server/control-handlers.js`, and the entire `public/` frontend.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
