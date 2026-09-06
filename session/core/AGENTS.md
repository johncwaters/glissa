<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# session/core

## Purpose
Pure cores seam-extracted from `sessions.js`: no fs, no git, no async, no Session import. The stateful Session class stays at the repo root by design. Everything here is deterministic and unit-testable in isolation.

## Key Files

| File | Description |
|------|-------------|
| `state-machine.ts` | `TRANSITIONS`, `GUARDS`, `ENTRY_HOOKS`, `EXIT_HOOKS` lifecycle tables for the session state machine (states defined in `shared/states.ts`) |
| `status-mapper.ts` | Pure `mapSignalToEvent(signal, state, confidence, activeAgents)` -> event or null; `activeAgents > 0` suppresses `ready` -> `task_complete` |
| `exit-transition.ts` | Pure `decideExitTransition(state, exitCode, signal, receivedFirstOutput)` -> `{ event, detail }`: the real-PTY-exit decision extracted from `Session._handlePtyExit` |
| `spawn-command.ts` | Agent-neutral command resolution and spawn mechanics; agent vocabulary lives in `../adapters/` |
| `spawn-env.ts` | Pure `buildAgentEnv(baseEnv, extraEnv, profile)`: the adapter's scrub/set profile applied plus the always-on Glissa marker scrub, optional PATH prepend, returns a copy |
| `agent-tracker.ts` | Live background sub-agent bookkeeping over a `Map<agent_id, ts>` with TTL prune; feeds the completion gate |
| `gate-release.ts` | Pure `decideGateRelease(...)` -> `cancel` / `gated` / `wait` / `release`: the ONE judge of whether a gate-held (deferred) `ready` may complete the card. Cancels any hold with a newer non-ready signal (by sequence, not clock), so a Stop held across a new turn can never fire |
| `wakeup-tracker.ts` | Pending self-revival bookkeeping (ScheduleWakeup / CronCreate / CronDelete); advisory metadata only, never gates a transition; self-expiring entries |
| `merge-prompt.ts` | Pure builder of the manual-merge handoff prompt pasted into a parked worktree's PTY |
| `rebase-gate.ts` | Pure `decideAutoRebase(...)` -> `{ action: 'rebase' }` or a skip with its reason: may a worktree be rebased onto a moved integration branch right now, unattended. `AUTO_REBASE_STATES` excludes WAITING (a paused turn resumes into the files a rebase would rewrite); the guard order is stated only by its test |
| `pack-notice.ts` | Pure `buildPackNotice(deliveredPacks, latestVersions)` -> the one Glissa-authored line a `UserPromptSubmit` hook response injects when a delivered context pack has been rebuilt; hard-capped, never pack content |
| `anti-slop-prompt.ts` | Fixed deterministic anti-slop note for `--append-system-prompt`; single line, no double quotes (must survive the cmd.exe shim re-parse) |
| `hook-relay-core.ts` | Pure rules for `../hook-relay.ts`: the `GLISSA_HOOK_URL` read, event-token normalization into the URL's last segment, the http/loopback/`/hook/` target refusals, and the payload size cap that matches the ingress body cap |
| `post-turn-rules.ts` | Pure idempotent post-turn hygiene rules, `(content) -> { content, findings }`; applied by `server/post-turn-checker.ts` |
| `slop-code-patterns.ts` | Pure regex-based code-slop detection (`detectCodeSlop`), Noise/Lies/Soul taxonomy, offsets only |

## For AI Agents

### Working In This Directory
- Purity is the contract: no IO, no timers, no EventEmitter, no requires from `sessions.js`. If a change needs IO, it belongs in the root-level shell (`sessions.ts`, `post-turn-checker.ts`).
- `post-turn-rules.ts`, `slop-code-patterns.ts`, `anti-slop-prompt.ts` and their tests must contain no literal em dash, en dash, or ellipsis character; build them via `String.fromCharCode`.
- Tracker modules (`agent-tracker.ts`, `wakeup-tracker.ts`) mutate the passed Map and return whether the set changed; follow that shape for any new tracker.
- Strings destined for the cmd.exe shim spawn path must avoid embedded double quotes (see `anti-slop-prompt.ts` header).

### Testing Requirements
- Every module here has a matching test in `tests/`; keep it green and extend it with the change.

## Dependencies

### Internal
- Consumed by `session/sessions.ts` and `server/post-turn-checker.ts`; depends only on siblings (e.g. `post-turn-rules.ts` -> `slop-code-patterns.ts`).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
