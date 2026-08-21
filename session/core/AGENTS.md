<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# session/core

## Purpose
Pure cores seam-extracted from `sessions.js`: no fs, no git, no async, no Session import. The stateful Session class stays at the repo root by design. Everything here is deterministic and unit-testable in isolation.

## Key Files

| File | Description |
|------|-------------|
| `state-machine.js` | `TRANSITIONS`, `GUARDS`, `ENTRY_HOOKS`, `EXIT_HOOKS` lifecycle tables for the session state machine (states defined in `shared/states.js`) |
| `status-mapper.js` | Pure `mapSignalToEvent(signal, state, confidence, activeAgents)` -> event or null; `activeAgents > 0` suppresses `ready` -> `task_complete` |
| `exit-transition.js` | Pure `decideExitTransition(state, exitCode, signal, receivedFirstOutput)` -> `{ event, detail }`: the real-PTY-exit decision extracted from `Session._handlePtyExit` |
| `spawn-command.js` | `classifyClaudeKind`, `resolveClaudeCommand`, `buildSpawnCommand`, `CLAUDE_CMD`: resolve-then-branch spawn (direct `.exe` vs `cmd.exe /c` shim fallback) |
| `spawn-env.js` | Pure `buildSpawnEnv(baseEnv)`: the 6-var scrub (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` etc.) + always-on `CLAUDE_CODE_NO_FLICKER`, optional PATH prepend, returns a copy |
| `agent-tracker.js` | Live background sub-agent bookkeeping over a `Map<agent_id, ts>` with TTL prune; feeds the completion gate |
| `gate-release.js` | Pure `decideGateRelease(...)` -> `cancel` / `gated` / `wait` / `release`: the ONE judge of whether a gate-held (deferred) `ready` may complete the card. Cancels any hold with a newer non-ready signal (by sequence, not clock), so a Stop held across a new turn can never fire |
| `wakeup-tracker.js` | Pending self-revival bookkeeping (ScheduleWakeup / CronCreate / CronDelete); advisory metadata only, never gates a transition; self-expiring entries |
| `merge-prompt.js` | Pure builder of the manual-merge handoff prompt pasted into a parked worktree's PTY |
| `rebase-gate.js` | Pure `decideAutoRebase(...)` -> `{ action: 'rebase' }` or a skip with its reason: may a worktree be rebased onto a moved integration branch right now, unattended. `AUTO_REBASE_STATES` excludes WAITING (a paused turn resumes into the files a rebase would rewrite); the guard order is stated only by its test |
| `pack-notice.js` | Pure `buildPackNotice(deliveredPacks, latestVersions)` -> the one Glissa-authored line a `UserPromptSubmit` hook response injects when a delivered context pack has been rebuilt; hard-capped, never pack content |
| `pack-read-tracker.js` | Pure pack read telemetry: `packForPath` classifies a Read tool call against the delivered pack dirs (normalization keyed on path SHAPE, so a Windows path folds case wherever the test runs), plus per-pack counts and the after-notice counter |
| `anti-slop-prompt.js` | Fixed deterministic anti-slop note for `--append-system-prompt`; single line, no double quotes (must survive the cmd.exe shim re-parse) |
| `post-turn-rules.js` | Pure idempotent post-turn hygiene rules, `(content) -> { content, findings }`; applied by `../post-turn-checker.js` |
| `slop-code-patterns.js` | Pure regex-based code-slop detection (`detectCodeSlop`), Noise/Lies/Soul taxonomy, offsets only |

## For AI Agents

### Working In This Directory
- Purity is the contract: no IO, no timers, no EventEmitter, no requires from `sessions.js`. If a change needs IO, it belongs in the root-level shell (`sessions.js`, `post-turn-checker.js`).
- `post-turn-rules.js`, `slop-code-patterns.js`, `anti-slop-prompt.js` and their tests must contain no literal em dash, en dash, or ellipsis character; build them via `String.fromCharCode`.
- Tracker modules (`agent-tracker.js`, `wakeup-tracker.js`) mutate the passed Map and return whether the set changed; follow that shape for any new tracker.
- Strings destined for the cmd.exe shim spawn path must avoid embedded double quotes (see `anti-slop-prompt.js` header).

### Testing Requirements
- Every module here has a matching `tests/<name>.test.js`; keep it green and extend it with the change.

## Dependencies

### Internal
- Consumed by `../sessions.js` and `../post-turn-checker.js`; depends only on siblings (e.g. `post-turn-rules.js` -> `slop-code-patterns.js`).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
