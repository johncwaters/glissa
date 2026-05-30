<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-30 -->

# tests/ — Automated Test Suite

## Purpose

The `node:test` suite run by `npm test` (`node --test "tests/**/*.test.js"`). Covers the detection pipeline, the spawn-command builder, the §4a signal x state transition matrix, and a ground-truth replay harness over recorded fixtures. All tests are deterministic and PTY-free — no test launches a real `claude` process or keeps a PTY alive.

## Key Files

| File | Description |
|------|-------------|
| `osc-title-source.test.js` | OSC-0 title parsing — braille spinner -> `working`, idle glyph -> `ready` (only after a spinner, stabilized), `unknown` for new glyphs, ASCII titles dropped. Exercises `isBrailleChar`/`isKnownIdleChar`/`findOscTitle` |
| `status-source.test.js` | `StatusSource` merge logic — immediate signals, the `ready` conflict window vs. a racing `awaiting-input`, dedup of duplicate signals, hook > title precedence |
| `hook-source.test.js` | `mapHookToSignal` event mapping and `HookRouter` token validation (404 unknown-session, 403 bad-token, 200 ok/ignored); plus `settings-injector` (`buildHookSettings`, `writeSessionSettings`, `sweepOrphans`) over a real localhost HTTP round-trip |
| `sessions-detection.test.js` | Integration: drives the real `statusSource.ingest -> _onStatus -> transition` path on a `Session`, asserting the §4a signal x state matrix with a short conflict window |
| `spawn-command.test.js` | Pure unit tests for `buildSpawnCommand` + `classifyClaudeKind` — every spawn branch (posix bare `claude`, win `.exe` direct, `.cmd`/`.bat`/`.ps1` -> `cmd.exe /c` fallback) without spawning a PTY |
| `spawn-integration.test.js` | Integration: `Session.start()` wires `buildSpawnCommand`'s `{file, args}` into an injected fake spawner. Windows-gated (the `.exe`-direct decision is win32-specific) |
| `replay-harness.test.js` | Drives recorded fixtures through `detection/replay.js` and asserts on resolved signal counts (e.g. complete-via-Stop emits `working`+`ready`, never `awaiting-input`) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `fixtures/` | Recorded session JSONL files replayed by `replay-harness.test.js` (v1 data-only, v2 data+hook). See "Fixtures" below |

## Fixtures

| Fixture | What it asserts |
|---------|-----------------|
| `v2-complete-stop.jsonl` | Turn ends via `Stop` hook -> `working`+`ready`, no false WAITING |
| `v2-waiting-permission.jsonl` | Permission `Notification` -> `working`+`awaiting-input`, never `ready` |
| `v2-conflict-stop-then-notify.jsonl` | `Stop` racing a permission `Notification` — conflict window lets `awaiting-input` win |
| `v1-true-positive.jsonl` | Legacy data-only recording exercising the title fallback |
| `v1-false-positive-conversational.jsonl` | Title fallback must NOT fire on conversational body text |
| `v1-layer3-colon-prompt.jsonl` | Legacy edge case retained as a regression guard |

## For AI Agents

### Working In This Directory

- **`node:test` + `node:assert/strict`**, CommonJS. New files must match `tests/**/*.test.js` to be picked up by `npm test`.
- Tests import server modules with `require('../<module>')`. Keep them deterministic: inject fakes (fake PTY handle, fake spawner, short timer windows) rather than spawning real processes or sleeping on real-world durations.
- Detection tests use **fast timer windows** (e.g. `{ stabilizationMs: 40, conflictWindowMs: 20, dedupWindowMs: 10 }`) so timer-gated behavior resolves quickly. Reuse that pattern.
- When changing detection behavior, prefer **adding a fixture** and asserting on resolved signals over asserting internal source state.
- This is the plural `tests/` dir (automated `node:test`). The singular `test/` dir holds custom console-runner scripts run by hand — see `test/AGENTS.md`. Do not conflate them.

### Testing Requirements

```bash
npm test          # run the whole suite
node --test tests/status-source.test.js   # run one file
```

## Dependencies

### Internal
- `../sessions` (`Session`, `buildSpawnCommand`, `classifyClaudeKind`)
- `../detection/*` (osc-title-source, status-source, hook-source, settings-injector, replay)
- `../shared/states` (`STATES`)

### External
- Node.js built-ins only: `node:test`, `node:assert/strict`, `node:http`, `node:fs`, `node:os`, `node:path`, `node:timers/promises`. No third-party test framework.

<!-- MANUAL: -->
