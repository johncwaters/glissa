# glissa

This file is loaded into EVERY session, so it holds only what every session needs: cross-cutting conventions and a lean map. A rule about one subsystem belongs in that subsystem's own AGENTS.md, which loads when that code is open. Never restate what code shows. Size, placement and citation rot are gated by `tests/agents-md-size.test.ts`.

## Purpose

Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions via node-pty, streams terminal output to a browser dashboard over WebSockets, derives session status from structural signals (Claude Code hooks plus an OSC-0 title fallback, never screen scraping), and notifies the operator through browser notifications.

## Architecture Map

| Path | Role |
|------|------|
| `server/index.ts`, `server/main.ts`, `vite.config.ts` | Production entry (bootstrap: handoff recovery, then the server module); frontend build and dev wiring |
| `vite.server.config.ts`, `vite.extension.config.ts`, `scripts/build.mjs` | The node and VS Code bundles, and the orchestrator that owns `dist/` |
| `server/runtime-paths.ts` | The ONLY derivation of where a shipped asset lives (pure core in `server/core/runtime-paths.ts`); nothing else may guess from `import.meta` |
| `config.json`, `package.json`, `biome.json`, `socket.yml` | Runtime/dev config; package, lint and scan policy |
| `DESIGN.md`, `DESIGN.json`, `PRODUCT.md` | Visual system and product definition |
| `docs/`, `bin/` | Design records and npm CLI |
| `server/` | Backend runtime and lanes (`server/AGENTS.md`) |
| `server/child-process-safe.ts` | The ONLY importer of `node:child_process`, bar the extension packed outside it |
| `server/git-workspace.ts` | The ONLY module allowed to run `git worktree` |
| `server/core/` | Pure decision modules for everything in `server/`, no IO |
| `session/` | Session domain (`session/AGENTS.md`) |
| `session/sessions.ts` | Session lifecycle and PTY ownership |
| `session/adapters/`, `session/core/` | Agent adapters and pure session cores |
| `detection/`, `notifications/` | Status signals and notification lifecycle |
| `packs/`, `shared/` | Pack sources and shared constants |
| `public/` | Browser dashboard (`public/AGENTS.md`) |
| `scripts/`, `tests/`, `test/` | Release scripts and tests |
| `tools/`, `assets/`, `dist/` | Dev tools, static assets and generated build output |

## For AI Agents

### Working In This Directory

- Everything is TypeScript ESM. Erasable syntax only (no enums, namespaces, parameter properties); relative imports carry explicit `.ts` extensions; the browser reaches `shared/` through the `#shared/*` imports map. Never `any`, never `as unknown as` (`tests/typecheck-gate.test.ts`).
- Node >=22.18.0 (where type stripping is on by default, which source mode and the `.test.ts` suite depend on; `node:sqlite` FTS5 at 22.16 is the secondary floor). Windows 11 and Linux, developed on v24.
- Do NOT add dependencies without explicit instruction.
- Status detection is structural (hooks plus OSC-0 title). Never reintroduce PTY body or content scraping.
- Spawn sessions with `pty.spawn`, never `child_process.spawn`, and never `shell: true`. Scrub env via `session/core/spawn-env.ts`.
- Session worktrees use the configured integration branch, or each repo's default branch when unset. Origin is the source of truth, as pinned by the git-workspace tests.
- All sessions share one event loop: no sync git or fs on recurring paths (polls, turn-end, watchers). Use async `execFile` with yields. One-shot cold paths may stay sync.
- Localhost-only trust boundary: never bind `0.0.0.0`, and keep the per-session bearer token check on `POST /hook/:glissaId/:event`.
- House character style: no literal em dash, en dash, ellipsis character, or emoji anywhere (source, tests, docs, commits). When code must emit one, build it via `String.fromCharCode`.
- Avoid `else`: prefer early returns and guard clauses.
- Prefer the seam pattern: pure logic in `session/core/` or a `*-core` module, thin IO shells around it. A pure core imports no Session and reads no clock.
- Inter-module communication via Node `EventEmitter`, not globals or direct coupling.
- The published package ships `dist/` only and runs built `.js`, because Node refuses type stripping inside `node_modules`. Resolve a shipped asset (relay, pack spec, CLI, dashboard) through `server/runtime-paths.ts`, never from `import.meta.dirname`: the same module runs from a source checkout and from `dist/`.
- Sessions are keyed by stable UUID `id`; `name` is display-only.
- Wire and persisted shapes are Zod schemas in `shared/contracts/`; boundaries parse and fail closed (`tests/contracts-config.test.ts` and siblings), and types come from `z.infer`, never hand-duplicated.
- `npm run typecheck` gates every tree at zero errors under full `strict` plus `erasableSyntaxOnly` and `verbatimModuleSyntax` (`tsconfig.json` for node code, `tsconfig.public.json` for the browser). No suppressions of any kind: `@ts-*` pragmas, `biome-ignore`, `as any`, and `as unknown as` all fail the gate (`tests/typecheck-gate.test.ts`).

### Testing Requirements

- Run `npm test` (the `node:test` suite in `tests/`) before claiming completion.
- New pure logic gets a unit test; detection changes must also pass the replay fixtures (`tests/replay-harness.test.ts`).
- Tests pin behavior better than prose: when a rule matters, add the test rather than a paragraph here.

### Common Patterns

- Dual WebSocket: data WS (`/terminals/:sessionId`, raw PTY bytes) and control WS (`/control`, JSON).
- Table-driven state machines (`session/core/state-machine.ts`, `shared/notification-states.ts`).
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

- No classes unless the pattern genuinely requires instance state.
- Propagate errors via EventEmitter `error` events or callbacks, not thrown exceptions in async paths.
- Code comments are banned entirely; name or restructure instead (`tests/typecheck-gate.test.ts` fails on any comment line).

## Development Workflow

- `npm run dev` - Vite dev server with HMR on 5173, backend attached via plugin (one process)
- `npm run build` / `npm start` - whole package to `dist/` (dashboard, node bundles, extension); the built server entry
- `npm test` - the `node:test` suite; `npm run test:container` adds the Docker remote-mode run

## Platform and Runtime

Windows 11 (Linux supported). Node floor and module split are stated under Working In This Directory.

## Dependencies

Runtime: `express`, `ws` (no Socket.IO and no abstraction over WebSockets, ever), `node-pty` (a real PTY; needs C++ build tools, VS Build Tools on Windows), and browser-only `@xterm/xterm` with `addon-fit` and `addon-webgl`.

`@parcel/watcher` backs the fs ingest source only, chosen because it applies ignores BEFORE watch registration, which keeps a `node_modules` tree from exhausting `inotify.max_user_watches` on Linux. A load failure disables that one source and nothing else.

Dev: `vite`, `tailwindcss` v4 with `@tailwindcss/vite`.

## Parallel Agent Work

Fan out over this repo by giving each agent its own git worktree, integrated back once clean, so lanes cannot collide in the working tree. A convention, not a runtime feature.
