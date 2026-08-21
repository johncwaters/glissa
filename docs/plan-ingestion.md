# Plan: multi-source ingestion pipeline

Status: redlined draft (two independent reviews applied), no milestone started. Continues the navigator plan (docs/plan-navigator.md, M1 to M5 shipped); milestone numbering continues from there.

## Goal

The navigator today sees exactly one thing: live editor buffers arriving over the LSP relay. A carbon unit's actual working context is wider: what they just committed, what a test run printed, what an agent session did, what command they last ran, which files just changed on disk. This plan builds one ingestion pipeline that normalizes those sources into a single bounded in-memory timeline, so the navigator's dispatch prompts (and any future consumer) can carry a cross-source digest of recent activity. Constraints, in order: extremely performant (push-based, bounded memory, zero cost when disabled), OS agnostic (Windows, macOS, Linux), and reuse of glissa's existing seams over new plumbing.

## Decision records

### File watching: @parcel/watcher only, no fallback watcher

- Built-in `fs.watch({ recursive: true })` works on all three OSes since Node 19.1, but has no ignore option until Node 25.5 (SEMVER-MINOR, not in any LTS). On Linux, recursive watching registers one inotify watch per subdirectory with no exclusion at registration time, so a project root containing `node_modules` exhausts `fs.inotify.max_user_watches` (ENOSPC). Known open bugs: spurious rename events for sibling paths sharing a name prefix (nodejs/node#58868, fix unmerged as of Aug 2026).
- chokidar v5 is ESM-only (glissa is CommonJS); v4 is CJS-compatible and pure JS but wraps the same recursive fs.watch, inheriting the registration-time ignore problem, so a chokidar fallback would silently reintroduce the exact failure the primary choice exists to avoid (redline finding).
- @parcel/watcher (v2.6.0, actively maintained, used by VS Code, Nx, Nuxt) applies ignores before watch registration, coalesces events in C++ (one event per file through an `npm install`), and ships 12 prebuilt platform binaries as optionalDependencies plus a wasm fallback, so no compile step in practice. glissa already carries one prebuilt native dep (node-pty), so this is precedent, not a new category.

Decision: `@parcel/watcher` is the only recursive watcher. If it fails to load on a platform, the fs source disables itself with one logged warning and every other source runs untouched; there is no degraded watcher mode.

### Tailing: compose the exported usage-scan-core helpers, do not touch usage-scanner

Both reviews flagged the original claim ("reuse `usage-scanner.js scanFile()`") as false: `scanFile` is a private closure inside `createUsageScanner`, coupled to pricing, dedup, and warehouse state. The correct seam is one level down: the pure decision pieces are already exported from `server/core/usage-scan-core.js` (`decideFileRead` for offset/truncation/restart decisions, `splitLines` for carry-aware line splitting). `ingest-tail-core.js` composes those exports with its own per-file state; the usage lane is not refactored and the offset rules are not duplicated. Tails start at end-of-file on first sight: ingestion is about recent activity, and replaying a 200MB history file into the rings on daemon start is exactly the cost this plan exists to avoid.

### Shell history: tail where the shell already writes incrementally, rc snippet where it does not

- PowerShell (PSReadLine) defaults to `SaveIncrementally`: the history file is appended on every accepted command, no config needed. PSReadLine also scrubs lines matching password/token/secret patterns before writing, which is a privacy win we inherit for free.
- fish writes history incrementally by default with timestamps.
- bash and zsh write only on shell exit by default; incremental capture requires a per-carbon-unit rc change (`PROMPT_COMMAND='history -a'` / `INC_APPEND_HISTORY`).

Decision: v1 tails history files for PowerShell and fish (works with zero setup) and documents the one-line rc snippet for bash and zsh. History events carry machine scope only: the files record no cwd, exit code, or duration, so commands cannot be correlated to a project, and the digest labels them accordingly (redline finding). An atuin-style preexec hook writing structured JSONL (command, cwd, duration, exit code, hence real correlation) is the recorded future path, not v1: it modifies the carbon unit's shell config, which needs an explicit install step, not a default.

### Git activity: watchers accelerate, the poll is the correctness floor

VS Code's git extension is the prior art: a non-recursive watch on the `.git` directory's top level plus refs paths, filtering out `index.lock` churn, debounced into one `git status` run. Packed refs make ref watching silently miss events, and non-recursive `refs/heads` misses nested branch names (`feature/x`), so watching alone can never be the source of truth. This matches the repo's standing invariant: watchers say look again, the owner recomputes.

Decision: per repo, watch the common git dir top level (`HEAD`, `index`, `packed-refs`, `MERGE_HEAD`/`REBASE_HEAD`) plus `refs/heads` non-recursively, and each active linked worktree's own gitdir via the existing `resolveWorktreeGitDir` (linked worktrees keep `HEAD`/`index` there, not in the common dir; redline finding). Lock files filtered, 1s debounce. Every trigger and the 60s poll funnel into one per-repo promise chain with a re-entrancy guard (a slow `git status` on a large repo outlives the debounce window), running `git status --porcelain=v2 --branch` plus `git log -1 --format=...` through `child-process-safe`. A `status-change` event publishes only when the porcelain signature differs from the last one, so overlapping trigger paths cannot double-report. The 60s poll is correctness, the watchers are latency.

### Storage: bounded in-memory rings, no database

The consumers need recent context, not history queries. Every source gets a ring bounded by both entry count and total bytes (table below); eviction is drop-oldest. No SQLite (a second native dep with no v1 consumer), no warehouse. An optional JSONL debug spool (off by default) exists solely for diagnosing an adapter; it writes post-scrub events only, and for the terminal and shellHistory sources it requires its own explicit config flag on top of the spool flag.

### Terminal output: ingestion layer only, honoring the detection prohibition

Root, detection, and session AGENTS.md all prohibit parsing terminal content in the PTY/detection stack, and that rule stands: state detection must never depend on tokenizing bytes. Ingestion is a different consumer with a different failure mode: a wrong summary in a model prompt degrades one suggestion, it cannot wedge a session state machine. The only processing is mechanical (ANSI strip, coalesce, cap) in a pure core; no semantic parsing, the model interprets, exactly like buffer text today.

The tap (corrected by redline; the original claim of a recorder precedent on `sess.on('data')` was wrong; the recorder taps inside `_handlePtyData` and the only existing `data` listener is the per-browser-connection sender):

- The ingest lane owns `attachSessionTap(sess)`, called from `wireSessionEvents` in backend.js only when the lane and the terminal source are both enabled. Detach on session `exit`, idempotent (session `destroy()` calls `removeAllListeners()`, so detach must tolerate already being gone).
- Only project sessions are tapped, never sessions registered through `registerEphemeralSession`. This is load-bearing: navigator dispatch sessions are PTY sessions too, and tapping them feeds the navigator's own output back into its next prompt (redline finding). The exclusion is by construction (the tap lives in `wireSessionEvents`, which ephemeral sessions never pass through) and is pinned by a test.
- Attaching a listener turns on `emit('data')` for sessions with no browser client attached; that cost is accepted and confined to sessions the tap covers.
- Backpressure is decided at the tap, before any decoding: raw chunks append to a per-session accumulator that keeps only its newest bytes (pre-strip cap, table below). A flush timer drains the accumulator through ANSI strip and coalescing into one event; when a session exceeds its per-window byte budget the overflow is dropped, never queued, and the event notes the truncation. `rebaseline` clears the accumulator (the screen was rewritten; pending bytes no longer describe appended output).

### Event granularity: summarize at the edge

Adapters push small normalized events, never raw payloads (the one exception: terminal chunks, which are capped and coalesced as above). A 400MB `npm install` fs storm must arrive as coalesced per-file events and leave the digest as one line. Cost is bounded at the adapter boundary, not at the consumer. Concretely, per source: terminal publishes one coalesced tail-of-output event per flush window; agent logs publish one event per completed turn or tool call, never per token; git publishes one signature-deduped status event per settled change; fs publishes per-file coalesced change events; shell history publishes one event per accepted command; editor publishes save and open/close markers (content already lives in the navigator lane).

## Architecture

```
 editor (LSP relay)        [exists: navigator lane]
 attachSessionTap      --\
 @parcel/watcher       ---\   adapters (IO shells,        server/core/ingest-core.js
 .git watchers + poll  ----&gt;  one per source,      ---&gt;   normalize + SCRUB -&gt; per-source ring
 usage-scan-core tails ---/   each config-gated)          -&gt; seq-stamped timeline
 history file tails    --/                                        |
                                                    +-------------+--------------+
                                              buildContextDigest()        ingest-snapshot +
                                              (pure, char-budgeted,       batched ingest-activity
                                               once per dispatch)         deltas (1s interval)
                                                     |                          |
                                          navigator dispatch prompt      Navigator tab activity feed
```

One lane (`ingest-wiring.js`), navigator-shaped: constructed only when `config.ingest.enabled === true`, `broadcast` injected, `snapshotMessage()` sent from a post-`registerControlHandlers` connection listener, deltas kept out of `REPLAYABLE_EXACT` (the snapshot repairs everything). No new event bus: adapters call the lane's `publish(event)` directly.

Normalized event: `{ source, kind, ts, seq, scope, summary, detail }`. `scope` is structured, `{ root, sessionId }`: `root` is the canonicalized project root (null only for shellHistory, which cannot know one), `sessionId` present where a session is involved. This gives every source one comparable correlation key instead of four incomparable ones (redline finding). `seq`, stamped by the core at publish, is the sole ordering key; `ts` is display-only, because source clocks disagree (git commit time vs tail arrival time vs PTY arrival time). `summary` is one bounded line; `detail` is optional, small, structured.

Scrubbing happens in the pure normalizer at publish time, before ring insertion, so a secret never sits in a ring, a snapshot, an activity delta, or the debug spool (redline finding; both reviews independently demanded this move). Pattern list follows PSReadLine's (password/token/key/secret assignments) plus common bearer/URL-credential shapes. `buildContextDigest` applies the same scrub again as defense in depth.

`buildContextDigest({ scopes, budgetChars, now })` is pure and synchronous: one snapshot pass over the rings with no await between reads, newest-first by `seq`, per-source quotas so one noisy source cannot starve the rest, hard char budget, stable text shape. It is built exactly once per navigator dispatch, never on publish. It becomes one fenced DATA section in `buildNavigatorPrompt`, framed exactly like buffer text.

Wire amplification is capped (redline finding): `publish` never broadcasts directly. Activity deltas batch on a 1s interval, at most one `ingest-activity` frame per interval carrying at most 50 events; overflow within an interval collapses to a count. A client that misses frames is repaired by the connect-time snapshot, same as the navigator tab.

## Lifecycle

- Construction: lane built only when `config.ingest.enabled === true`; each adapter built only when its source flag is true. Lane off means zero constructions, zero listeners, zero timers.
- Adapter contract: every adapter returns `{ start, stop }`. `stop()` cancels its timers, closes its watchers and tails, and detaches its session taps; `ingestLane.stop()` calls every adapter's `stop()` and is wired into the daemon shutdown path beside the navigator lane.
- Adapter failure: a throwing watcher or tail disables that source with one logged warning; the lane and every other source keep running. No retry loops in v1; a restart re-arms everything.
- Daemon restart: rings are in-memory by design, so they start empty and the digest section is simply absent until events arrive. No persistence in v1.
- Config changes: config-file only (like the navigator lane), so changes take effect on daemon restart. No live reload plumbing in v1.
- Session lifecycle: terminal taps attach per session in `wireSessionEvents` and detach on exit. fs watchers follow active sessions when `fs.roots` is empty: ref-counted per root (the existing watcher-pool pattern), added when the first session in a root starts, removed when its last session exits.

## Sources

| Source | Kinds | Scope | Ring caps | Timing | Reuses |
|---|---|---|---|---|---|
| terminal | `output` | session cwd root + sessionId | 200 events / 256KB | 500ms flush; 8KB pre-strip accumulator; drop past 64KB per window | Session EventEmitter, `wireSessionEvents`, rebaseline signal |
| agentLogs | `agent-turn`, `agent-tool` | decoded project dir root | 200 / 128KB | tail wakeup + 2s stat backstop; EOF start | `usage-scan-core` `decideFileRead`/`splitLines`, `conversation-history` dir encoding |
| git | `commit`, `status-change`, `branch-change` | repo root | 100 / 64KB | 1s debounce; 60s poll; signature dedupe | `child-process-safe`, `resolveWorktreeGitDir`, `createWatchDebounce`, `canonicalizePath` |
| fs | `file-change` | watched root | 500 / 128KB | C++ coalescing + 500ms batch | `canonicalizePath`, watcher-pool pattern |
| shellHistory | `command` | machine (root null) | 100 / 32KB | tail wakeup + 2s stat backstop | shared tail core |
| editor | `doc-save`, `doc-open`, `doc-close` | file uri root | 100 / 32KB | immediate (debounced upstream) | navigator lane (exists) |

Ring caps and timing values are defaults resolved in the pure config resolver, overridable per source in config; they are the load-bearing bound, not tuning suggestions.

Shared tail mechanics (agentLogs and shellHistory): watch the parent directory, not the file (rename/rotation safety), read from last offset on wakeup, treat size shrink as truncation, 2s stat-poll backstop for Windows write-event coalescing, first sight starts at EOF.

## Module placement

| Module | Kind | Holds |
|---|---|---|
| `server/core/ingest-core.js` | pure | event normalization, scrub, rings, seq, digest builder, config resolver |
| `server/core/ingest-git-core.js` | pure | porcelain v2 + log parsing, watch-set derivation, status signatures |
| `server/core/ingest-tail-core.js` | pure | tail state composing `usage-scan-core` exports, rotation decisions |
| `server/core/ingest-terminal-core.js` | pure | accumulator, ANSI strip, coalescing, caps |
| `server/ingest-wiring.js` | IO shell | lane lifecycle, publish, batched broadcast, snapshot, stop |
| `server/ingest-fs.js` | IO shell | @parcel/watcher subscription per root |
| `server/ingest-git.js` | IO shell | watchers + per-repo promise chain + git spawns + poll |
| `server/ingest-terminal.js` | IO shell | attachSessionTap, flush timers, detach |
| `server/ingest-agent-logs.js` | IO shell | tail-driven reader over vendor roots |
| `server/ingest-shell-history.js` | IO shell | history file tails |
| `public/navigator-view-core.mjs` / `navigator-panel.js` | frontend | activity feed section in the existing Navigator tab (no new tab in v1) |

## Config

Config-file only, never control-WS settable (the navigator rule, same reasoning: a settable ingestion path widens what an unauthenticated local socket can turn on). Every source individually opt-in; `enabled: true` at the top plus per-source flags:

```json
"ingest": {
  "enabled": true,
  "sources": {
    "terminal": { "enabled": true },
    "agentLogs": { "enabled": true },
    "git": { "enabled": true },
    "fs": { "enabled": true, "roots": [] },
    "shellHistory": { "enabled": false }
  }
}
```

`shellHistory` defaults off even when ingest is on: it is the one source reading data created outside glissa's own surfaces. `fs.roots` empty means "roots of projects with active sessions", the cheap default; explicit roots widen it.

## Privacy and trust posture

Everything stays on the machine: rings are in-memory, the digest leaves the daemon only inside a navigator dispatch prompt, which already frames untrusted text as DATA and runs under the `--allowedTools=Write` + deny-list posture with a throwaway cwd. Terminal output and shell history can contain secrets, so the scrub runs at publish time in the pure normalizer (nothing unscrubbed ever sits in a ring, crosses the control WS, or reaches the spool), with a second pass in the digest builder as defense in depth. Ephemeral lane sessions (navigator, pr-review, posthog, pack-distill) are never tapped, which both keeps their output out of prompts and prevents the navigator-ingests-itself feedback loop. The ingest lane is refused to remote-trust sockets exactly like the navigator lane.

## Milestones

Each milestone is test-gated, committed through the runner, and lands visible value on its own.

- M6: lane plus terminal source. `ingest-core` (events, scrub, rings, digest), `ingest-terminal-core`, `ingest-wiring` (batched deltas, snapshot, stop), config gating, `attachSessionTap` in `wireSessionEvents` with the ephemeral-session exclusion pinned by a test, activity feed section in the Navigator tab, digest section in `buildNavigatorPrompt` (empty digest renders as absent). Acceptance: lane off costs zero constructions; a command run in a glissa session surfaces in the tab and in the next dispatch prompt's digest; a multi-MB synthetic output burst stays inside the ring and accumulator caps under test; a secret-shaped string in terminal output never appears in a ring entry.
- M7: agent-log source. `ingest-tail-core` composing the `usage-scan-core` exports, EOF start, vendor roots. Acceptance: finishing a turn in an agent session surfaces an `agent-turn` event end to end without rescanning history.
- M8: git source. Watch-set including linked-worktree gitdirs, per-repo promise chain, signature dedupe, 60s poll. Acceptance: a commit made from any terminal shows up as one `commit` event within the debounce window, with branch and subject; a no-op trigger storm publishes nothing.
- M9: fs source. The @parcel/watcher dependency lands here, with the ignore set, ref-counted roots, and load-failure disablement. Acceptance: editing a file outside the editor surfaces one coalesced event; `npm install` in a watched root does not flood the ring past its caps.
- M10: shell history source. PSReadLine + fish tails, machine-scope labeling, bash/zsh rc snippet documented in this file. Acceptance: a command accepted in an external PowerShell lands as a `command` event without any shell config change.
- M11: digest quality pass. Per-source quotas tuned against real dispatch transcripts, scrub patterns hardened against a fixture corpus of secret shapes. Acceptance: a recorded before/after comparison of digest sections from live transcripts stays within budget with every source active, and this doc records the default-on decision per source.

## Non-goals

- Capturing output of terminals glissa does not own (only history files reach outside glissa's PTYs).
- Semantic parsing of terminal bytes for state detection (the standing prohibition is untouched).
- A queryable history store, cross-machine sync, or any cloud component.
- Editor-specific integrations beyond the existing LSP relay (IDE agnosticism is already carried by it).
- Keystroke capture of any kind.
- Ingesting ephemeral lane sessions' output.

## Risks

- inotify watch limits on Linux: mitigated by registration-time ignores in @parcel/watcher; if the watcher cannot load, the fs source disables itself rather than degrading to an unmitigated watcher.
- Windows event coalescing and missed file-change events: every tail carries a stat-poll backstop; watchers are treated as lossy wakeups with the owner recomputing truth (the repo's standing invariant); the git poll is the correctness floor.
- Packed refs and nested branch dirs silencing git ref watches: the 60s poll.
- Prebuild coverage gaps for @parcel/watcher: wasm fallback exists; the fs source degrades to disabled with a logged warning rather than failing the lane.
- Secret leakage via terminal/history text into prompts: publish-time scrub plus digest-time second pass, sources individually opt-in, shellHistory default-off, ephemeral sessions never tapped.
- 8.3 short paths crashing native watchers: every watched path goes through `canonicalizePath` first, no exceptions.
- Event-loop cost of terminal bursts: pre-strip accumulator cap and drop-not-queue budget, verified by a burst test in M6 acceptance.
