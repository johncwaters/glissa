# Engineering Conventions

Distilled from the project `AGENTS.md`. Informational reference for OMC
workflows. `AGENTS.md` remains the authoritative source; if the two ever
disagree, `AGENTS.md` wins and this file should be updated.

## Platform and runtime

- Target OS is Windows 11; Node v24+.
- Server code is **CommonJS only** (`const x = require('x')`, `module.exports = { ... }`). No ESM in server code.
- Frontend code is ES modules, bundled by Vite.

## Dependencies

- Do **NOT** add dependencies (runtime or dev) without explicit instruction.
- Runtime deps are deliberately minimal: `express`, `ws`, `node-pty`, `@xterm/*`. Keep it that way.

## Module structure and communication

- Inter-module communication uses Node.js `EventEmitter`. No global variables, no direct coupling between modules.
- No classes unless the pattern genuinely requires instance state.
- Keep functions small and single-purpose.
- Prefer explicit over clever.

## Error handling

- In async paths, propagate errors via `EventEmitter` `error` events or callbacks. Do not throw exceptions in async paths.

## Session model

- Sessions are keyed by a stable UUID (`id`), never the mutable display `name`. All Maps, WebSocket routes, and control messages key on `id`. `name` is display-only.
- The session state machine is 7 explicit string-constant states (`INITIALIZING -> STARTING -> RUNNING -> WAITING -> IDLE -> DONE`, with `FAILED`). Transitions are explicit; no implicit state mutation.

## Status detection (structural signals, not screen scraping)

- Status is derived from machine-emitted signals only: Claude Code hooks (authoritative) plus the OSC-0 title (fallback). Never from parsing the rendered TUI.
- The PTY data path does **NO** content parsing beyond scanning for OSC-0 titles. Do not reintroduce body/line scraping.

## Session spawning (node-pty)

- Spawn `claude` via node-pty `pty.spawn()`, never `child_process.spawn` (the Claude CLI produces no output with piped stdio; a real PTY is required).
- Before spawn, unset: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`.
- Do **NOT** use `shell: true`; pass args as an array.

## WebSocket transport

- Use the `ws` package directly. Do **NOT** use Socket.IO or any abstraction over WebSockets.
- Two channels: data WebSocket (`/terminals/:sessionId`, raw bidirectional PTY bytes) and control WebSocket (`/control`, JSON messages).
- xterm.js does **all** ANSI rendering in the browser; the server is a dumb pipe.

## CSS

- Tailwind utility classes for static HTML markup (`index.html`).
- Semantic classes in `style.css` for JS-created DOM elements.
- State-driven styles via `[data-state]` attribute selectors in `style.css`.
- Animations (`@keyframes`) and pseudo-elements (`::before`) live in `style.css`.
- Theme is defined in `public/tailwind.css` via the `@theme` block.

## Security boundary

See `security.md`. In short: localhost-only, never bind `0.0.0.0`; preserve the per-session hook bearer-token check on `POST /hook/:glissaId/:event`.

## Parallel agent work

When multiple agents (Claude Code native teams or several spawned agents) edit this repo at once, each works in its own git worktree (`isolation: "worktree"`) and integrates back when clean, to avoid working-tree collisions. Distinct from the Glissa Teams product feature and from the OMC `omc team` / tmux runtime (unavailable on native Windows).
