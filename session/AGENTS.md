<!-- Generated: 2026-07-03 -->

# session

## Purpose
The session domain: the stateful Session class (lifecycle, PTY spawn/kill, timers, hook ingestion), its always-on recorder, and the pure cores it delegates to.

## Key Files

| File | Description |
|------|-------------|
| `sessions.js` | Session class; consumes StatusSource and drives the 7-state machine |
| `session-background-tracking.js` | Stateful background-work, readiness-gate, and scheduled-wakeup collaborator |
| `session-recorder.js` | Always-on JSONL recorder of PTY data + signals; feeds `detection/replay.ts` |
| `hook-relay.js` | Standalone command-hook relay for a non-Claude agent CLI: stdin envelope to the local hook ingress, always exit 0; never required by the server (decisions in `core/hook-relay-core.js`) |
| `adapters/` | One adapter per supervised agent CLI (`claude-code.js`, `codex.js`) plus the registry and its lazy per-agent command cache; see root `AGENTS.md` ("Agent Adapters") |
| `core/` | Pure cores of a SEAM EXTRACTION from `sessions.js`: no IO, no Session import (see `core/AGENTS.md`) |

## For AI Agents
- New Session logic that can be pure goes in `core/` with a unit test in `tests/`; the class keeps only state and side effects.
- Status detection is structural (hooks + OSC-0 title). Never reintroduce PTY body/content scraping.
- See root `AGENTS.md` ("Status Detection", "Session State Machine") before touching transitions or the completion gate.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Session Spawning

- Claude CLI produces zero output with piped stdio, so a real PTY is required.
- Resolve-then-branch: a PE image spawns directly, a shim falls back to `cmd.exe /c`, avoiding cmd's double command-line parse and console-title write (`session/core/spawn-command.js`).
- The env scrub removes the Glissa marker vars, or Claude believes it runs inside itself.

### Auto-Resume and Shutdown

- The Claude session id is captured from WHICHEVER main-agent hook arrives: SessionStart does not reliably fire, and keying it there left boot auto-resume dead in production.
- It persists at HOOK time, not shutdown, which makes a hard kill lossless. Shutdown never writes config, since `wasActive` surviving IS the resume signal.
- No captured id means dormant; never guess with `--continue`. A stale id fails the session, flipping `wasActive` false, so there is no retry loop.
- Every lane's `stop()` is awaited under a bound, or a restart runs a fresh backend while the old one still writes the same state file; an overrunning lane is named and left behind. Cleanup waits for the killed PTY tree's reap, a surviving handle inside a worktree having failed the discard and leaked the checkout.
