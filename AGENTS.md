<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# glissa

## Purpose
Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions via node-pty, streams terminal output to a browser dashboard over WebSockets, derives session status from structural signals (Claude Code hooks plus an OSC-0 title fallback, never screen scraping), and notifies the operator through browser notifications. It also ships "Teams": project-portable headless agent pipelines (marketing, changelog, qa) that run in isolated git worktrees.

## Key Files

| File | Description |
|------|-------------|
| `server.js` | Production entry point, thin wrapper around `backend.js` |
| `backend.js` | Express + WebSocket server factory, shared by `server.js` and the Vite dev plugin |
| `sessions.js` | Session class: lifecycle, PTY spawn/kill, timers, hooks; consumes StatusSource; delegates pure logic to `session-core/` |
| `control-handlers.js` | Control-WebSocket message handlers (kill, restart, rename, settings, team control) |
| `config-store.js` | Runtime config load/save/defaults (default path `~/.glissa/config.json`), key whitelists for control updates |
| `notification-manager.js` | Notification lifecycle state machine (states in `shared/notification-states.js`) |
| `scheduler.js` | In-process calendar/cron for scheduled team runs; Intl-based timezone offset-solving |
| `session-recorder.js` | Always-on JSONL recorder of PTY data + signals (v1 legacy, v2 structural-signal format); feeds the replay harness |
| `spawn-gate.js` | Process-wide async serialization of `pty.spawn` initiation (ConPTY wedge avoidance) |
| `ws-sender.js` | Data-WebSocket sender: batching, bufferedAmount backpressure, echo fast-flush |
| `post-turn-checker.js` | Thin async IO runner for post-turn hygiene checks; applies pure rules from `session-core/post-turn-rules.js` to a session's git-changed files |
| `vite.config.js` | Vite frontend build config + backend-attach plugin (ESM) |
| `biome.json` | Lint/format config (worktrees inherit the nested-config gotcha from main) |
| `package.json` | CommonJS package; `files` whitelist validated by `scripts/check-package-files.js` |
| `CLAUDE.md` | Project agent instructions: architecture, conventions, design decisions. Read it first |
| `DESIGN.md` / `DESIGN.json` | Dashboard visual design system |
| `PRODUCT.md` | Product definition and positioning (canonical; `docs/PRODUCT.md` is an older design-context doc) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `bin/` | npm CLI entry (see `bin/AGENTS.md`) |
| `channels/` | Notification delivery adapters (see `channels/AGENTS.md`) |
| `detection/` | Status detection: hook + title sources, watchers, replay (see `detection/AGENTS.md`) |
| `docs/` | Design docs, postmortems, plans (see `docs/AGENTS.md`) |
| `public/` | Browser dashboard frontend, ES modules bundled by Vite (see `public/AGENTS.md`) |
| `scripts/` | Release and package validation scripts (see `scripts/AGENTS.md`) |
| `session-core/` | Pure cores extracted from `sessions.js`, no IO (see `session-core/AGENTS.md`) |
| `shared/` | State constants shared by server (CJS) and browser (ESM) (see `shared/AGENTS.md`) |
| `teamlib/` | Team runtime server modules (see `teamlib/AGENTS.md`) |
| `teams/` | Team definitions: rosters, role prompts, pack templates (see `teams/AGENTS.md`) |
| `test/` | Manual/smoke tests (see `test/AGENTS.md`) |
| `tests/` | Automated `node --test` suite (see `tests/AGENTS.md`) |
| `tools/` | Auxiliary dev tooling, e.g. the company-context MCP server (see `tools/AGENTS.md`) |
| `assets/` | Repo-level static assets (see `assets/AGENTS.md`) |
| `dist/` | Vite production build output, gitignored, never edit |

## For AI Agents

### Working In This Directory
- Server code is CommonJS only (`require` / `module.exports`); frontend is ESM bundled by Vite. Node v24+, Windows 11.
- Do NOT add dependencies without explicit instruction.
- Status detection is structural (hooks + OSC-0 title). Never reintroduce PTY body/content scraping.
- Spawn sessions with `pty.spawn` (never `child_process.spawn`), no `shell: true`; scrub env via `session-core/spawn-env.js`.
- All sessions share one Node event loop: no sync git/fs on recurring paths (polls, turn-end, watchers); use async `execFile` with yields. One-shot cold paths may stay sync.
- Localhost-only trust boundary: never bind `0.0.0.0`; keep the per-session bearer token check on `POST /hook/:glissaId/:event`.
- House style: no literal em dash, en dash, ellipsis character, or emoji anywhere (source, tests, docs, commits). When code must emit such a character, build it via `String.fromCharCode`.
- Avoid `else`: prefer early returns and guard clauses.
- Prefer the seam pattern: pure logic in `session-core/` or `*-core.mjs` modules, thin IO shells around them.
- Inter-module communication via Node `EventEmitter`, not globals or direct coupling.
- Sessions are keyed by stable UUID `id`; `name` is display-only.

### Testing Requirements
- Run `npm test` (node:test based suite in `tests/`) before claiming completion.
- New pure logic gets a unit test in `tests/`; detection changes should also pass the replay harness fixtures.

### Common Patterns
- Resolve-then-branch spawn: `claude` resolved once at module load; `.exe` spawned directly, `.cmd`/`.bat`/`.ps1` shims fall back to `cmd.exe /c claude`.
- Dual WebSocket: data WS (`/terminals/:sessionId`, raw PTY bytes) and control WS (`/control`, JSON messages).
- Table-driven state machines (`session-core/state-machine.js`, `shared/notification-states.js`) with explicit transitions.

## Dependencies

### External
- `express` - HTTP server and static serving
- `ws` - WebSocket server (no Socket.IO, ever)
- `node-pty` - real PTY spawning (requires VS Build Tools on Windows)
- `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl` - browser-only terminal rendering
- Dev: `vite`, `tailwindcss`, `@tailwindcss/vite`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
