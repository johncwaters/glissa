# Completion-gate deletion plan

Scope: `session/core/agent-tracker.js`, `gate-release.js`, `wakeup-tracker.js`, `status-mapper.js`,
the gate touchpoints in `session/sessions.js`, and their tests.

Verdicts: **(a) incident-pinned** (a regression test encodes an observed failure, keep the behavior),
**(b) speculative** (no observed input, no pinning test, delete), **(c) redundant** (another mechanism
subsumes it).

| Mechanism | Verdict | Evidence |
|---|---|---|
| Counted `SubagentStart`/`Stop` map (`_activeAgents`) | (a) keep | `sessions-detection` "counted map coverage: a SubagentStart-counted teammate id keeps the card gated well past the teammate TTL" + "a name-based zero must not wipe a live counted subagent". Between two Stops it is the ONLY fresh evidence; the declared snapshot only refreshes on a Stop. |
| Declared `background_tasks` snapshot (`_bgDeclared`) + `max(counted, declared)` | (a) keep | Sees background Bash tasks and teammates that fire no `SubagentStart` ("a declared shell task stops gating past its TTL", "accepted risk: a dropped-SubagentStart teammate..."). Neither side subsumes the other. |
| `extractBackgroundTasks` settled-status deny-list | (a) keep | `agent-tracker.test` "drops settled entries" + `sessions-detection` "Stop declaring only a settled-status entry completes". |
| `NON_GATING_TASK_TYPES` (`dream`) | (a) keep | "a Stop declaring only a dream entry does not suppress completion". |
| `WEAK_TASK_TYPES` TTL (`shellTaskTtlMs`) | (a) keep | Shell/monitor entries get no completion hook at all; "a declared shell task stops gating past its TTL and the held ready is released". |
| `teammateTaskTtlMs` | (a) keep | Three tests, including the documented accepted-risk one; without it an idle-but-alive teammate pinned WORKING for the full 30 min agent TTL. |
| `agentTtlMs` prune (counted map + whole snapshot) | (a) keep | "a held ready still completes when the dropped SubagentStop only ages out (TTL timer)". |
| `msUntilNextDrain` (remaining-TTL re-arm) | (a) keep | "a still-gated re-arm waits the remaining declared TTL, not a fresh full one" (live incident: 2x TTL stuck-WORKING). |
| Idle-teammate-by-NAME channel (`_idleTeammateNames`, `idleNameCount`) | (a) keep | Six tests, incl. "TeammateIdle with an unmapped name only offsets ONE of several live teammates" and the clamp tests. Per AGENTS.md `TaskCreated` never fires for named-agent teammates, so this is the only drain they have. |
| `evictDepartedTeammateNames` | (a) keep | "REGRESSION: a departed teammate idled by name does not mask a newly declared different teammate". |
| Teammate name -> task_id map (`_teammateTasks`) + the resolved branch in `teammate-idle` | **(c) delete** | Redundant with the by-name channel, which must work anyway (AGENTS.md: no `TaskCreated` for named-agent teammates, and a declared entry can never be matched to a name). For every declared teammate the two paths compute the same gate count: an id drain filters one teammate entry, an idle name subtracts one teammate entry, clamped to the live teammate count. Every test that exercises `TaskCreated` + `TeammateIdle` (639, 655, 908) passes on the name path alone. Deleting it removes a second bookkeeping channel for one failure. |
| `_idleTaskIds` (TaskCompleted by id) | (a) keep | "TaskCompleted drains a declared background task without waiting for the next Stop" - covers shell tasks, which have no name channel. |
| Gate-held ready latch (`_gateHeldReady`) + release timer | (a) keep | The whole deferred-completion path; many tests, incl. destroy() timer hygiene. |
| `decideGateRelease` quiet window (`gateReleaseSettleMs`) | (a) keep | Incident 2026-08-14: the drain lands 1-3s before the mailbox wake. |
| `_gateQuietSince` reset on the drain edge | (a) keep, simplify | Same incident ("measures the quiet window from the last still-gated moment"). Behavior kept; the extra mirror variable below is not needed to express it. |
| `_gateLastObservedActive` | **(c) delete (fold)** | State mirroring state: it exists only to detect the >0 -> 0 edge, which `_gateQuietSince` can express directly with `0` meaning "still gating, not quiet yet". Same verdicts on every path (stash, gated, drain, redundant re-evaluation), so the incident test still passes. |
| Signal sequence staleness (`_signalSeq` / `_lastActivitySeq`) | (a) keep | `gate-release.test` "orders by arrival, not by clock" + "cancels when activity was seen AFTER the stash (the incident)". |
| `resyncWorkingLatch()` on stash | (a) keep | `gate-release.test` "INCIDENT: a held ready must NOT complete a card whose title is still spinning". |
| `_clearGateHeldReady` on subagent-start / task-created | (a) keep | "a fresh subagent-start invalidates a held ready". |
| `status-mapper` `activeAgents` parameter | (a) keep | Pinned exhaustively by `status-mapper-matrix.test` (signal x state x confidence x activeAgents). Moving the gate into the caller would mean editing kept-behavior tests. |
| Double `mapSignalToEvent` call in `_onStatus` | keep | The second call is an honest "what would this be ungated" query; collapsing it would copy the gate rule out of the mapper into the caller. Not a net simplification. |
| `pruneAgents(_idleTeammateNames, agentTtlMs)` | (b)-ish, keep | No pinning test, but it is one line bounding a leak; deleting it ADDS a failure mode (a stale name masking a future same-named teammate) rather than removing one. |
| `wakeup-tracker` `extractCronTaskId` field probing | (a) keep | Pinned by `pending-wakeup.test` for both `tool_input.task_id` and `tool_response.id`. |
| `wakeup-tracker` `MAX_WAKEUPS`, self-expiry | (a) keep | Pinned; cancellation is invisible (claude-code#58235). |
| Repeated `const before = _activeAgentCount() ... if (changed) emit` (7 sites) | fold | Pure duplication; one `_withAgentCount(mutate)` helper. |
| Repeated 4-line reset block at PTY start and PTY exit | fold | Order-sensitive (`_clearGateHeldReady` must precede `_clearAgents`); one helper removes the chance of a third site getting the order wrong. |

Net: the gate is almost entirely incident-pinned. Two mechanisms come out (`_teammateTasks`,
`_gateLastObservedActive`), the rest is duplication folding. Honest delta is small by design.
