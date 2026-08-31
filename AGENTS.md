# glissa

This file is loaded into EVERY session, so it holds only what every session needs: cross-cutting conventions and a lean map. A rule about one subsystem belongs in that subsystem's own AGENTS.md, which loads when that code is open. Never restate what code shows. Size, placement and citation rot are gated by `tests/agents-md-size.test.js`.

## Purpose

Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions via node-pty, streams terminal output to a browser dashboard over WebSockets, derives session status from structural signals (Claude Code hooks plus an OSC-0 title fallback, never screen scraping), and notifies the operator through browser notifications.

## Architecture Map

| Path | Role |
|------|------|
| `server.js`, `vite.config.js` | Production entry; frontend build and dev wiring |
| `config.json`, `package.json`, `biome.json`, `socket.yml` | Runtime/dev config; package, lint and scan policy |
| `DESIGN.md`, `DESIGN.json`, `PRODUCT.md` | Visual system and product definition |
| `docs/`, `bin/` | Design records and npm CLI |
| `server/` | Backend runtime and lanes (`server/AGENTS.md`) |
| `server/child-process-safe.js` | The ONLY importer of `node:child_process`, bar the extension packed outside it |
| `server/git-workspace.js` | The ONLY module allowed to run `git worktree` |
| `server/core/` | Pure decision modules for everything in `server/`, no IO |
| `session/` | Session domain (`session/AGENTS.md`) |
| `session/sessions.js` | Session lifecycle and PTY ownership |
| `session/adapters/`, `session/core/` | Agent adapters and pure session cores |
| `detection/`, `notifications/` | Status signals and notification lifecycle |
| `packs/`, `shared/` | Pack sources and shared constants |
| `public/` | Browser dashboard (`public/AGENTS.md`) |
| `scripts/`, `tests/`, `test/` | Release scripts and tests |
| `tools/`, `assets/`, `dist/` | Dev tools, static assets and generated build output |

## For AI Agents

### Working In This Directory

- Server `.js` stays CommonJS; the Mill measurement lane is `.ts` run by Node type stripping as the migration beachhead. Frontend is ESM bundled by Vite.
- Node >=22.18.0 makes native type stripping unflagged and exceeds the `node:sqlite` FTS5 floor. Windows 11 and Linux, developed on v24.
- Do NOT add dependencies without explicit instruction.
- Status detection is structural (hooks plus OSC-0 title). Never reintroduce PTY body or content scraping.
- Spawn sessions with `pty.spawn`, never `child_process.spawn`, and never `shell: true`. Scrub env via `session/core/spawn-env.js`.
- Session worktrees use the configured integration branch, or each repo's default branch when unset. Origin is the source of truth, as pinned by the git-workspace tests.
- All sessions share one event loop: no sync git or fs on recurring paths (polls, turn-end, watchers). Use async `execFile` with yields. One-shot cold paths may stay sync.
- Localhost-only trust boundary: never bind `0.0.0.0`, and keep the per-session bearer token check on `POST /hook/:glissaId/:event`.
- House character style: no literal em dash, en dash, ellipsis character, or emoji anywhere (source, tests, docs, commits). When code must emit one, build it via `String.fromCharCode`.
- Avoid `else`: prefer early returns and guard clauses.
- Prefer the seam pattern: pure logic in `session/core/` or a `*-core` module, thin IO shells around it. A pure core imports no Session and reads no clock.
- Inter-module communication via Node `EventEmitter`, not globals or direct coupling.
- Sessions are keyed by stable UUID `id`; `name` is display-only.
- Wire and persisted shapes are Zod schemas in `shared/contracts/`; boundaries parse and fail closed (`tests/contracts-*.test.js`).
- `npm run typecheck` gates `server/`, `session/`, `detection/`, `notifications/`, `shared/` and `public/` at zero errors under `strictNullChecks` and the rest of the strict family `tests/typecheck-gate.test.js` pins. The checked set only grows, no file may opt out with `@ts-nocheck`/`@ts-ignore`, and no file may launder an assertion through `unknown` (`tests/typecheck-gate.test.js`).

### Testing Requirements

- Run `npm test` (the `node:test` suite in `tests/`) before claiming completion.
- New pure logic gets a unit test; detection changes must also pass the replay fixtures (`tests/replay-harness.test.js`).
- Tests pin behavior better than prose: when a rule matters, add the test rather than a paragraph here.

### Common Patterns

- Dual WebSocket: data WS (`/terminals/:sessionId`, raw PTY bytes) and control WS (`/control`, JSON).
- Table-driven state machines (`session/core/state-machine.js`, `shared/notification-states.js`).
- Lane shape: pure rules in a core, deps injected into an IO-free poller, a thin wiring shell owning the timers.

## Invariants

Each subsystem states its own rules beside its code, so a rule is loaded when that code is open and never charged to every session. Never restate one here.

| Subsystem | Rules live in |
|---|---|
| Status Detection, Session Recording | `detection/AGENTS.md` |
| Agent Adapters | `session/adapters/AGENTS.md` |
| Session Spawning, Auto-Resume and Shutdown | `session/AGENTS.md` |
| Notifications | `notifications/AGENTS.md` |
| Worktree Auto-Rebase, Remote Branch GC, GitHub PR Auto-Review, Radar / PostHog Auto-Fix, Usage Tracking, Mill Measurement, Long-Term Memory, Ephemeral Lane Write Boundaries, Security: Trust Boundary, Transport and Session Identity | `server/AGENTS.md` |
| Context Packs | `packs/AGENTS.md` |
| Dashboard Layouts | `public/AGENTS.md` |

## Coding Style

- Server `.js` is CommonJS: `const x = require('x')`, `module.exports = { ... }`.
- No classes unless the pattern genuinely requires instance state.
- Propagate errors via EventEmitter `error` events or callbacks, not thrown exceptions in async paths.
- Comments are a last resort and carry only the why.

## Development Workflow

- `npm run dev` - Vite dev server with HMR on 5173, backend attached via plugin (one process)
- `npm run dev:server-only` - Express backend only on 3000
- `npm run build` / `npm start` - production bundle to `dist/`; production server
- `npm test` - the `node:test` suite; `npm run test:container` adds the Docker remote-mode run

## Platform and Runtime

Windows 11 (Linux supported). Node floor and module split are stated under Working In This Directory.

## Dependencies

Runtime: `express`, `ws` (no Socket.IO and no abstraction over WebSockets, ever), `node-pty` (a real PTY; needs C++ build tools, VS Build Tools on Windows), and browser-only `@xterm/xterm` with `addon-fit` and `addon-webgl`.

`@parcel/watcher` backs the fs ingest source only, chosen because it applies ignores BEFORE watch registration, which keeps a `node_modules` tree from exhausting `inotify.max_user_watches` on Linux. A load failure disables that one source and nothing else.

Dev: `vite`, `tailwindcss` v4 with `@tailwindcss/vite`.

## Parallel Agent Work

Fan out over this repo by giving each agent its own git worktree, integrated back once clean, so lanes cannot collide in the working tree. A convention, not a runtime feature.
