<!-- Generated: 2026-07-03 -->

# session

## Purpose
The session domain: the stateful Session class (lifecycle, PTY spawn/kill, timers, hook ingestion), its always-on recorder, and the pure cores it delegates to.

## Key Files

| File | Description |
|------|-------------|
| `sessions.js` | Session class; consumes StatusSource, drives the 7-state machine, owns the background-work completion gate |
| `session-recorder.js` | Always-on JSONL recorder of PTY data + signals; feeds `detection/replay.js` |
| `core/` | Pure cores of a SEAM EXTRACTION from `sessions.js`: no IO, no Session import (see `core/AGENTS.md`) |

## For AI Agents
- New Session logic that can be pure goes in `core/` with a unit test in `tests/`; the class keeps only state and side effects.
- Status detection is structural (hooks + OSC-0 title). Never reintroduce PTY body/content scraping.
- See root `CLAUDE.md` ("Status Detection", "Session State Machine") before touching transitions or the completion gate.
