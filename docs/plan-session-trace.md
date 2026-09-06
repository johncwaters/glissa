# Plan: Session Trace

Status: slice 1 (capture) shipped 2026-09-06; slice 2 (view) open.

## Why

Debugging a prompt or a skill means seeing what the agent actually did with it: the prompt as submitted, what a slash command or skill expanded to, what the model thought, which tools it called with which inputs, what came back, and what it said at the end. The PostHog wizard exposes this for its own agent runs by appending every Claude Agent SDK message to a per-run log file (`src/utils/debug.ts` `logToFile`) and mirroring assistant turns into PostHog AI Observability (`src/lib/agent/aio-capture.ts`). Glissa has nothing equivalent for the sessions it manages, so debugging a skill today means scrolling a terminal that has already redrawn.

What exists is either lossy, memory-only, or keyed by the wrong thing:

- The investigation trail (`server/core/investigation-trail-core.ts`) keeps 80 steps of `{at, tool, detail}` in memory, one 160-char field per tool, for the Radar lane only, never written to disk.
- The session recorder (`session/session-recorder.ts`) writes hook payloads to `~/.glissa/recordings/<project>-<timestamp>.jsonl`, named by project rather than session UUID, and only for events that map to a status signal: `writeHook` sits inside `ingestHookSignal` (`session/sessions.ts:499`), so a `PreToolUse` event under `observeToolCalls` reaches `hook-event` listeners and never the file.
- The agent-log ingest source (`server/ingest-agent-logs.ts`) already tails every Claude, Codex and Grok transcript on the machine, but it publishes `AgentIngestEvent` rows built for memory: a prompt summary, a tool name and one target field, capped at 4000 chars, with tool results and thinking dropped at the mapping (`server/core/ingest-agent-core.ts:199`, `:228`).
- `tool_response` appears nowhere in the tree, `transcript_path` is discarded (`detection/hook-source.ts` parses the envelope and nothing keeps the field), and no HTTP route or control message exposes any of it.

## Sources compared

Three ways to observe a Claude Code session, verified against the hooks, sessions and monitoring docs on 2026-09-06:

| Source | Prompt text | Slash and skill expansion | Thinking | Assistant text | Tool input | Tool result | Subagent calls | Cost per event |
|---|---|---|---|---|---|---|---|---|
| Hooks (`type: "http"`) | `UserPromptSubmit.prompt` | `UserPromptExpansion` gives command name and args only, never the body | never | `Stop.last_assistant_message`, `MessageDisplay.delta` | `PreToolUse.tool_input`, capped by the 64 KB body limit (`server/backend-http.ts:176`) | needs an unmatched `PostToolUse`, doubling hook traffic; same cap | tagged `agent_id`, `agent_type` | one synchronous HTTP round trip per tool call inside the agent's turn |
| Transcript JSONL at `transcript_path` | yes | yes: the `Skill` tool result is only `Launching skill: <name>`, the body follows as an `isMeta` user record whose `sourceToolUseID` points at that call; a typed `/skill` lands as a user record carrying the expansion | yes | yes | full | full | sibling files under `<session-id>/subagents/agent-<id>.jsonl`, handed over by `SubagentStop.agent_transcript_path`, with `isSidechain` and `agentId` on every record | zero inside the agent; a file tail on Glissa's side |
| OpenTelemetry raw API bodies (`OTEL_LOG_RAW_API_BODIES=file:<dir>`) | yes, inside the whole request | yes | redacted always | yes | yes | yes | yes | the entire conversation history per model request; needs an OTLP receiver and only works from shell or user settings |

The transcript is the only source that carries the three things the debugging goal needs and hooks never will: thinking, the expanded skill body, and full tool results. Its format is declared internal and version-unstable (sessions doc, monitoring doc), which Glissa already accepts for memory ingestion. The mitigation is the same: parse per line, fail closed to a `raw` record, and pin the parser with fixtures cut from real transcripts on this machine.

Not planned: the effective system prompt. Only the OpenTelemetry path shows it, at the price of an OTLP receiver, spawn env changes, and the whole conversation on disk per model request, for one field outside the ask.

## What already exists

Reuse, do not rebuild:

- The join between a Glissa session and its vendor transcript: `session/sessions.ts:521` captures `payload.session_id` from the first hook and emits `claude-session-id` `{id, source, vendor, sessionId}` (`:566`), consumed by `server/session-event-wiring.ts:85` and `server/ephemeral-session.ts:187`. `transcript_path` rides the same payload and is one field away.
- The tailer: `server/ingest-agent-logs.ts` `createAgentLogIngest` owns `fs.watch` per directory (`:497`), per-file byte offsets through the pure `server/core/ingest-tail-core.ts` (`createTailState`, `planRead`, `applyRead`), a catch-up cap, a 2000 ms poll fallback (`:24`), and a `consumers` array with a per-consumer `userPrompts` opt-in (`:76`, `:597`). `server/memory-ingest-wiring.ts:244` is the model consumer: it attaches to the ingest lane's source when that runs and starts its own instance otherwise (`:253`). Two properties matter for a trace: a discovered file starts at its current size (`ingest-tail-core.ts:69`), so a file found by the directory scan loses whatever was written before discovery, and the Claude root is scanned at `maxDepth: 1` (`:198`), so `subagents/` is never reached. The trace lane reuses the pure tail core and leaves this source alone.
- Transcript line helpers: `parseTimestamp`, `firstTextBlock` and the content-block walk in `server/core/ingest-agent-core.ts`.
- Append-only JSONL: `server/json-file.ts` `appendJsonLine` and `appendJsonLineIdle`; retention by age over flat files in `session/session-recorder.ts:185` with `DEFAULT_RETAIN_DAYS` (`:15`); clamped ranges in `shared/settings-ranges.ts`.
- Safe session id segments: `isSafePathSegment` (`server/core/upload-core.ts:39`).
- Per-session request and reply over the control WS: the `debug-state` handler (`server/control-handlers.ts:1014`) and its `debug-state-response` variant; the browser `messageHandlers` table (`public/app.ts:281`). Trust per socket is `ws.glissaTrust`, checked today only in `broadcastLocalControl` (`server/backend-websockets.ts:109`); the `refuseRemote` in `server/backend-control.ts:134` gates connect-time lane snapshots, not handlers.
- Views: every pull-surface view is a global tab section (`public/index.html:182-189`) in the registry at `public/app.ts:572`, a pure `*-view-core.ts` beside a `*-panel.ts` shell, chrome from `public/dom-helpers.ts`, empty states from `public/lane-placeholder-core.ts`. The one-line-per-tool label table `DETAIL_FIELD_BY_TOOL` sits unexported in `server/core/investigation-trail-core.ts:16`, which browser code cannot import.

## Decisions

1. The transcript is the source, the first hook is the trigger. `claude-session-id` gains a `transcriptPath` field read from the same payload. No new hook subscription: an unmatched `PostToolUse` is a synchronous round trip inside the agent's turn, the 64 KB body cap drops exactly the Write and Edit calls a skill debugger most wants, and it still yields no thinking and no skill body.
2. The trace lane owns one tailer per bound Glissa session, built on the pure `server/core/ingest-tail-core.ts` (`createTailState`, `applyRead`) plus a contiguous read planner in `server/core/trace-tail-core.ts`, and `server/ingest-agent-logs.ts` is not touched at all. A shared cursor is what forced this: one source holds one offset and one slot table per file, so a trace binding rewinding or releasing a file changes what memory ingestion sees, and a per-session lifecycle (`/clear`, resume, exit) cannot be expressed in a table sized for machine-wide discovery. Each binding keeps its own validated transcript path, byte offset, carry and Skill call ids, polls every 2 s while bound, and commits a checkpoint sidecar `~/.glissa/traces/<sessionId>.checkpoint.json` after each flush so a Glissa restart resumes at the last complete line instead of replaying retained history. The checkpoint remembers a committed offset per transcript path, bounded to the 16 most recent, because a terminal returned to a conversation it already traced would otherwise replay it from zero. The append and the checkpoint are two writes, so a bind also reads the tail of its own trace file and resumes at the greater of the two offsets, and a failed append requeues its batch and leaves the checkpoint where it was: the committed offset never passes a record the file did not accept. Every hook-supplied path passes one validator before any read: `realpath` of the candidate and of the Claude projects root, containment, then `open` with `O_RDONLY | O_NONBLOCK` and `isFile()` on the handle, so a symlinked directory, a FIFO or a swapped path is refused rather than read; the binding keeps the resolved path, so a rebind the validator refuses keeps the working binding and a sidechain root cannot be widened by a symlink. Subagent transcripts are read once, bounded, on `SubagentStop`, which Glissa already subscribes to and which carries `agent_transcript_path`, under the resolved transcript's own directory. A teardown fires before the pty reap, so it marks the binding closing and keeps it for one last drain at shutdown rather than dropping it.
3. One flat file per Glissa session UUID: `~/.glissa/traces/<sessionId>.jsonl` via `configSiblingPath`, guarded by `isSafePathSegment`, never cwd-relative. A restart, resume or `/clear` that changes the vendor session id appends a `session` record to the same file, so "what did this terminal do" has one answer. Retention prunes trace files and their checkpoints by file age with the trace lane's own constant, on server start and daily after that, skipping any session still bound.
4. Normalized records. `shared/contracts/trace.ts` defines `TraceRecord`, a discriminated union on `kind`: `session`, `prompt`, `expansion`, `thinking`, `assistant`, `tool_call`, `tool_result`, `notice`, `raw`. Every record carries `ts`, `uuid`, `parentUuid`, the vendor session id, `agentId` plus `agentType` when the line came from a subagent, and an optional `transcriptOffset` stamped on the last record of each batch, which is what lets a restart tell an appended batch from a lost one. `notice` carries what the lane itself skipped, so `raw` stays the format-change canary rather than a mixed bag. `expansion` covers both the `isMeta` user record linked by `sourceToolUseID` to a `Skill` call and the typed-command user record. Prompts, expansions and thinking are stored whole; tool results up to 65536 chars and marked `truncated` past it, because a `Read` of a large file is the one record that can dominate the file without informing the debugger. Lines with no debugging value (`file-history-snapshot`, `attachment`, `queue-operation`, `ai-title`, `bridge-session`, the latches, compaction summaries) are dropped; `raw` is reserved for a line the parser does not recognise, so a Claude Code release that changes the format shows up as a run of `raw` rows instead of silence. The mapping is a pure `server/core/trace-core.ts` sharing the timestamp and content-block helpers of `ingest-agent-core.ts`.
5. One config boolean, `trace.enabled`, default true, a file-only key with a read-only Settings row like `recordSignals` (`public/settings-map.ts:196`). On by default for the recorder's reason: the prompt worth debugging is the one already sent.
6. Bodies cross the control WS only on request, only to a local socket. `session-trace` `{id, after}` answers `session-trace-response` `{id, records, next}` reading from a byte offset, shaped like `debug-state`; the handler refuses a socket whose `glissaTrust` is `remote` in one line, so nothing new leaves the machine. A pushed `session-trace-changed` `{id}` carries no body and is listed as refreshable in `server/core/control-send-core.ts`, because the next request repairs a dropped one. The memory rule in `server/AGENTS.md:104` already scopes itself to the memory prompt record and stays as written. The hook reply stays `{ok, reason}`.
7. A `Trace` tab in the existing view registry with a session selector, preselected when opened from the session card's overflow menu with the constant label `Trace`. `public/trace-view-core.ts` (pure: records grouped into turns headed by their prompt, one-line labels) beside `public/trace-panel.ts`. Each turn shows the prompt, then thinking, tool call, tool result and assistant rows collapsed to one line and expandable to the full body in a `<pre>` with copy; subagent rows carry their agent type inline. `DETAIL_FIELD_BY_TOOL` moves to `shared/` so the trail and the trace label a tool the same way. The JSONL path is shown in the header so the operator can grep it. No filters, no follow mode: the view refetches on the nudge and the newest turn is last.

## Shape

| Piece | Where | Role |
|---|---|---|
| `TraceRecord`, `session-trace`, `session-trace-response`, `session-trace-changed` | `shared/contracts/trace.ts`, `shared/contracts/control-messages.ts` | Persisted and wire shapes, `z.infer` types |
| `trace.enabled` | `shared/contracts/config.ts`, `public/settings-map.ts` | File-only toggle, read-only row |
| `transcriptPath` on `claude-session-id` | `session/sessions.ts:521` | One field on an event that already fires |
| `planContiguousRead`, `resumeOffsetFrom`, `committedOffsetFromTraceTail`, `withCommittedOffset`, `isPathInsideRoot` | `server/core/trace-tail-core.ts` | Pure: per-tick read window, checkpoint resume and reset, the offset recovered from the trace tail, the bounded per-path offsets, path containment |
| `TraceCheckpoint` | `shared/contracts/trace.ts` | Sidecar shape: transcript path, vendor session id, committed offset, ingested sidechains, committed offset per transcript path |
| `trace-core.ts` | `server/core/` | Pure: line to record, drop table, truncation, skill linkage |
| `trace-wiring.ts` | `server/` | The lane: one validated tailer per bound session, 2 s poll, checkpoint after each accepted flush, one bounded read on `SubagentStop`, batched appends to `traces/<id>.jsonl`, age prune on start and daily skipping bound sessions, emits `session-trace-changed` |
| `session-trace` handler | `server/control-handlers.ts` | Offset read, local socket only |
| `DETAIL_FIELD_BY_TOOL` | `shared/` | Moved so `public/` can label a tool |
| `trace-view-core.ts`, `trace-panel.ts`, `view-trace` section | `public/` | Turn grouping and labels; DOM shell; tab registration |
| `Trace` menu item | `public/session-card/card-dom.ts` | Opens the tab with that session selected |
| Invariant | `detection/AGENTS.md`, "Session Trace" | Two lines: transcript not hooks, and bodies only on local request |

## Done when

- Capture: a Claude Code session produces `~/.glissa/traces/<id>.jsonl` from its first prompt, every record round-trips through the schema, and memory ingestion's events are byte-identical before and after.
- View: a running session's tool calls appear in the Trace tab within a poll interval of the transcript write, bodies expand, the skill body shows under its `Skill` call, a subagent's calls appear after it stops, and a remote socket's request is refused.

## Tests

- `tests/trace-core.test.ts`: fixtures cut from real transcripts on this machine with bodies replaced, one per record kind, plus the drop table, the truncation flag, an unrecognised line becoming `raw`, the `Skill` linkage, and a subagent line keeping `agentId`.
- `tests/trace-tail-core.test.ts`: the read window at the byte bound, a file shorter than the committed offset, the resume point for a matching and a different transcript path, and containment of a candidate outside the root.
- `tests/trace-wiring.test.ts`: append, offset read, age prune, refusal of an unsafe session id, attach-or-start against the memory wiring pattern.
- `tests/control-trace.test.ts`: the request and reply, the refreshable nudge, and the remote-socket refusal.
- `tests/frontend-trace-view.test.ts`: turn grouping and labels.
- `tests/settings-injector-user-hooks.test.ts` is unchanged: no new hook is installed.

CHALLENGE: 0 kept, 10 shrunk, 4 cut
