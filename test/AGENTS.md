<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-30 -->

# test/ — Manual Runner Scripts

## Purpose

Standalone, hand-run test scripts using a tiny custom `assert(label, ...)` console harness (not `node:test`). These are NOT picked up by `npm test` (which globs `tests/**/*.test.js`) — run each directly with `node test/<file>`. Use them for flows that need a live in-process server or a full state-machine exercise that reads better as a narrated script.

## Key Files

| File | Description |
|------|-------------|
| `test-notification-manager.js` | Exercises the `NotificationManager` state machine — IDLE -> PENDING -> DELIVERED happy path, escalation ping-pong, focus suppression, category debounce — against `shared/notification-states.js`. Custom pass/fail counter |
| `smoke-dormant-boot.js` | In-process smoke test: boots `createBackend` on port 3098, connects a control WebSocket, asserts dormant-by-default boot and the start-session control flow. Tees `console.log` to assert on the per-session spawn line |

## For AI Agents

### Working In This Directory

- CommonJS, run by hand: `node test/test-notification-manager.js`, `node test/smoke-dormant-boot.js`.
- These use a local `assert(label, actual, expected)` (or `assert(label, cond)`) helper and a `passed`/`failed` counter, printing `PASS`/`FAIL` lines — they do NOT use `node:test`.
- `smoke-dormant-boot.js` starts a real backend in-process and opens a real WebSocket; it sets `GLISSA_PORT` and shuts down on exit. Keep it self-contained so it cleans up its server.
- This is the singular `test/` dir. The plural `tests/` dir holds the automated `node:test` suite run by `npm test` — see `tests/AGENTS.md`. Do not move files between them without also updating the test glob / run instructions.

### Testing Requirements

```bash
node test/test-notification-manager.js
node test/smoke-dormant-boot.js
```

A non-zero `failed` count indicates a regression. These are not wired into CI's `npm test`; run them manually when touching `notification-manager.js` or the boot/control flow.

## Dependencies

### Internal
- `../notification-manager` (`NotificationManager`)
- `../shared/notification-states` (`NOTIFICATION_STATES`)
- `../backend` (`createBackend`), `../sessions` (`CLAUDE_CMD`)

### External
- `node:http`, `node:events` (built-ins); `ws` (WebSocket client for the smoke test)

<!-- MANUAL: -->
