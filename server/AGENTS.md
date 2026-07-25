<!-- Generated: 2026-07-03 -->

# server

## Purpose
Backend runtime: the Express + WebSocket server factory and its control plane, plus shared server plumbing (config store, scheduler, spawn gate, WS sender, post-turn checks, safe child-process wrapper).

## Key Files

| File | Description |
|------|-------------|
| `backend.js` | Express + WebSocket server factory, shared by root `server.js` and the Vite dev plugin |
| `control-handlers.js` | Control-WebSocket message handlers (kill, restart, rename, settings, team control) |
| `server-lifecycle.js` | Boot/shutdown lifecycle helpers |
| `ws-sender.js` | Data-WebSocket sender: batching, bufferedAmount backpressure, echo fast-flush |
| `scheduler.js` | In-process calendar/cron for scheduled team runs |
| `post-turn-checker.js` | Async IO runner for post-turn hygiene checks (pure rules in `../session/core/post-turn-rules.js`) |
| `spawn-gate.js` | Process-wide async serialization of `pty.spawn` initiation (ConPTY wedge avoidance) |
| `config-store.js` | Runtime config load/save/defaults; resolves the repo-root `config.json` via `__dirname/..` |
| `child-process-safe.js` | THE ONLY module allowed to import `node:child_process` (enforced by `tests/no-direct-child-process.test.js`) |

## For AI Agents
- These modules live one level below the repo root: filesystem assets (`dist/`, `public/`, `teams/`, `config.json`, `node_modules/`) resolve via `path.join(__dirname, '..', ...)`. Keep that offset when adding paths.
- CommonJS only; no new dependencies without explicit instruction; avoid `else` (guard clauses).
- See root `AGENTS.md` for architecture and conventions.
