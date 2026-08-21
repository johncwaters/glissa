# Plan: multi-source ingestion pipeline

Status: draft, no milestone started. Continues the navigator plan (docs/plan-navigator.md, M1 to M5 shipped); milestone numbering continues from there.

## Goal

The navigator today sees exactly one thing: live editor buffers arriving over the LSP relay. A carbon unit's actual working context is wider: what they just committed, what a test run printed, what an agent session did, what command they last ran, which files just changed on disk. This plan builds one ingestion pipeline that normalizes those sources into a single bounded in-memory timeline, so the navigator's dispatch prompts (and any future consumer) can carry a cross-source digest of recent activity. Constraints, in order: extremely performant (push-based, bounded memory, zero cost when disabled), OS agnostic (Windows, macOS, Linux), and reuse of glissa's existing seams over new plumbing.

## Decision records

### File watching: @parcel/watcher, not built-in fs.watch, not chokidar

- Built-in `fs.watch({ recursive: true })` works on all three OSes since Node 19.1, but has no ignore option until Node 25.5 (SEMVER-MINOR, not in any LTS). On Linux, recursive watching registers one inotify watch per subdirectory with no exclusion at registration time, so a project root containing `node_modules` exhausts `fs.inotify.max_user_watches` (ENOSPC). Known open bugs: spurious rename events for sibling paths sharing a name prefix (nodejs/node#58868, fix unmerged as of Aug 2026).
- chokidar v5 is ESM-only (glissa is CommonJS); v4 is CJS-compatible and pure JS but wraps the same recursive fs.watch, inheriting the registration-time ignore problem.
- @parcel/watcher (v2.6.0, actively maintained, used by VS Code, Nx, Nuxt) applies ignores before watch registration, coalesces events in C++ (one event per file through an `npm install`), and ships 12 prebuilt platform binaries as optionalDependencies plus a wasm fallback, so no compile step in practice. glissa already carries one prebuilt native dep (node-pty), so this is precedent, not a new category.

Decision: `@parcel/watcher` as the fs-event backend, with chokidar v4 as the documented fallback if a platform lacks a prebuild. This is the one new dependency the plan adds.

### Shell history: tail where the shell already writes incrementally, rc snippet where it does not

- PowerShell (PSReadLine) defaults to `SaveIncrementally`: the history file is appended on every accepted command, no config needed. PSReadLine also scrubs lines matching password/token/secret patterns before writing, which is a privacy win we inherit for free.
- fish writes history incrementally by default with timestamps.
- bash and zsh write only on shell exit by default; incremental capture requires a per-carbon-unit rc change (`PROMPT_COMMAND='history -a'` / `INC_APPEND_HISTORY`).

Decision: v1 tails history files for PowerShell and fish (works with zero setup) and documents the one-line rc snippet for bash and zsh. An atuin-style preexec hook writing to our own JSONL (which would also capture cwd, duration, and exit code) is recorded as future work, not v1: it modifies the carbon unit's shell config, which needs an explicit install step, not a default.

### Git activity: watch-then-status, copied from VS Code, with a safety poll

VS Code's git extension is the authoritative prior art: a non-recursive watch on the `.git` directory's top level plus specific refs paths, filtering out `index.lock` churn, debounced about 1s into one `git status` run. Packed refs make per-ref watching silently miss events, so a low-frequency poll backstop is required (lazygit still polls outright at 10s). Linked worktrees resolve through the git common dir, which glissa's `resolveWorktreeGitDir` already handles.

Decision: non-recursive watch on the common git dir (`HEAD`, `index`, `packed-refs`, `MERGE_HEAD`/`REBASE_HEAD`, `refs/heads`), lock files filtered, debounce about 1s, then one `git status --porcelain=v2 --branch` plus `git log -1 --format=...` through `child-process-safe`. A 60s poll catches packed-ref silence. Parsing is pure core; glissa's existing `worktree-watch`/`integration-ref-watch` stay untouched (they serve detection, not ingestion).

### Storage: bounded in-memory rings, no database

The consumers need recent context, not history queries. Every source gets a ring bounded by both entry count and total bytes; eviction is drop-oldest. No SQLite (a second native dep with no v1 consumer), no warehouse. An optional JSONL debug spool (off by default) exists solely for diagnosing an adapter.

### Terminal output: ingestion layer only, honoring the detection prohibition

Root, detection, and session AGENTS.md all prohibit parsing terminal content in the PTY/detection stack, and that rule stands: state detection must never depend on tokenizing bytes. Ingestion is a different consumer with a different failure mode: a wrong summary in a model prompt degrades one suggestion, it cannot wedge a session state machine. The tap is `sess.on('data')` (the recorder precedent, zero PTY changes) and the only processing is mechanical: ANSI stripping, chunk coalescing, and byte caps in a pure core. No semantic parsing; the model interprets, exactly like buffer text today.

### Event granularity: summarize at the edge

Adapters push small normalized events, never raw payloads (the one exception: terminal chunks, which are capped and coalesced). A 400MB `npm install` fs storm must arrive as coalesced per-file events and leave the digest as one line. This is the load-bearing performance rule: cost is bounded at the adapter boundary, not at the consumer.

## Architecture

```
 editor (LSP relay)        [exists: navigator lane]
 sess.on('data') taps  --\
 @parcel/watcher       ---\   adapters (IO shells,        server/core/ingest-core.js
 .git watchers         ----&gt;  one per source,      ---&gt;   normalize -&gt; per-source ring
 usage-scanner tailer  ---/   each config-gated)          -&gt; seq-stamped timeline
 history file tails    --/                                        |
                                                    +-------------+--------------+
                                              buildContextDigest()        ingest-snapshot +
                                              (pure, char-budgeted)       ingest-activity deltas
                                                     |                          |
                                          navigator dispatch prompt      Navigator tab activity feed
```

One lane (`ingest-wiring.js`), navigator-shaped: constructed only when `config.ingest.enabled === true`, `broadcast` injected, `snapshotMessage()` sent from a post-`registerControlHandlers` connection listener, deltas kept out of `REPLAYABLE_EXACT` (the snapshot repairs everything). No new event bus: adapters call the lane's `publish(event)` directly.

Normalized event: `{ source, kind, ts, scope, summary, detail, seq }`. `source` is the adapter id; `kind` is a per-source enum (`commit`, `status-change`, `file-change`, `command`, `agent-turn`, `output`); `scope` is a project path or session id for correlation; `summary` is one bounded line; `detail` is optional, small, and structured. `seq` is stamped by the core.

`buildContextDigest({ scopes, budgetChars, now })` is pure: newest-first merge across rings, per-source quotas so one noisy source cannot starve the rest, hard char budget, stable text shape. It becomes one fenced DATA section in `buildNavigatorPrompt`, framed exactly like buffer text.

## Sources

| Source | Feed | Reuses | New work |
|---|---|---|---|
| Editor buffers | exists (navigator lane) | everything | publish didSave/doc events into the timeline |
| Terminal output (glissa sessions) | `sess.on('data')` attached in `wireSessionEvents` | Session EventEmitter, recorder precedent, rebaseline signal | ANSI strip + coalesce + cap core |
| AI agent logs | tail `~/.claude`, `~/.codex`, `~/.grok` projects JSONL | `usage-scanner.js scanFile()` walk + offset state, `conversation-history.js` dir encoding | entry-to-event mapping core |
| Git activity | watch common git dir, then porcelain v2 | `child-process-safe`, `resolveWorktreeGitDir`, `createWatchDebounce`, `canonicalizePath` | watch-set + parse core + safety poll |
| Project fs events | @parcel/watcher on active project roots | `canonicalizePath`, watcher-pool pattern | new dep, ignore set, event normalization |
| Shell history | tail PSReadLine / fish files; bash/zsh rc snippet | tail pattern shared with agent logs | per-shell path resolution, scrub pass |

Shared tail mechanics (agent logs and shell history): watch the parent directory, not the file (rename/rotation safety), read from last offset on wakeup, treat size shrink as truncation, and keep a 2s stat-poll backstop for Windows write-event coalescing. The offset state shape is `usage-scanner`'s, reused.

## Module placement

| Module | Kind | Holds |
|---|---|---|
| `server/core/ingest-core.js` | pure | event normalization, rings, seq, digest builder, config resolver |
| `server/core/ingest-git-core.js` | pure | porcelain v2 + log parsing, watch-set derivation |
| `server/core/ingest-tail-core.js` | pure | offset/truncation/rotation decisions, line splitting |
| `server/core/ingest-terminal-core.js` | pure | ANSI strip, chunk coalescing, caps |
| `server/ingest-wiring.js` | IO shell | lane lifecycle, publish, broadcast, snapshot |
| `server/ingest-fs.js` | IO shell | @parcel/watcher subscription per root |
| `server/ingest-git.js` | IO shell | watchers + git spawns + safety poll |
| `server/ingest-terminal.js` | IO shell | session tap attach/detach |
| `server/ingest-agent-logs.js` | IO shell | scanFile-driven tailer |
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

Everything stays on the machine: rings are in-memory, the digest leaves the daemon only inside a navigator dispatch prompt, which already frames untrusted text as DATA and runs under the `--allowedTools=Write` + deny-list posture with a throwaway cwd. Terminal output and shell history can contain secrets: the digest builder applies a scrub pass (the PSReadLine pattern list: password/token/key/secret assignments) before any text enters a prompt, and the ingest lane is refused to remote-trust sockets exactly like the navigator lane.

## Milestones

Each milestone is test-gated, committed through the runner, and lands visible value on its own.

- M6: lane skeleton plus consumer wiring. `ingest-core` (events, rings, digest), `ingest-wiring`, config gating, snapshot + activity deltas, activity feed section in the Navigator tab, digest section added to `buildNavigatorPrompt` (empty digest renders as absent). Acceptance: lane off costs zero constructions; a synthetic published event appears in the tab and in a dispatch prompt.
- M7: terminal + agent-log sources. The two pure-reuse adapters. Acceptance: running a command in a glissa session and finishing an agent turn both surface as timeline events end to end.
- M8: git source. Watch-set, porcelain v2 parse, safety poll. Acceptance: a commit made from any terminal shows up as a `commit` event within the debounce window, with the branch and subject line.
- M9: fs source. The @parcel/watcher dependency lands here, with the ignore set and coalescing. Acceptance: editing a file outside the editor surfaces one coalesced event; `npm install` in a watched root does not flood the ring past its caps.
- M10: shell history source. PSReadLine + fish tails, scrub pass, bash/zsh rc snippet documented in this file. Acceptance: a command accepted in an external PowerShell lands as a `command` event without any shell config change.
- M11: digest quality pass. Per-source quotas tuned against real dispatch transcripts, scrub-pass tests hardened, and a decision recorded on whether any source earns default-on.

## Non-goals

- Capturing output of terminals glissa does not own (only history files reach outside glissa's PTYs).
- Semantic parsing of terminal bytes for state detection (the standing prohibition is untouched).
- A queryable history store, cross-machine sync, or any cloud component.
- Editor-specific integrations beyond the existing LSP relay (IDE agnosticism is already carried by it).
- Keystroke capture of any kind.

## Risks

- inotify watch limits on Linux: mitigated by registration-time ignores in @parcel/watcher; the fallback (chokidar v4) does not mitigate it, so the fallback path documents the sysctl.
- Windows event coalescing and missed file-change events: every tail carries a stat-poll backstop; watchers are treated as lossy wakeups with the owner recomputing truth (the repo's standing invariant).
- Packed refs silencing git ref watches: the 60s safety poll.
- Prebuild coverage gaps for @parcel/watcher: wasm fallback exists; the fs source degrades to disabled with a logged warning rather than failing the lane.
- Secret leakage via terminal/history text into prompts: scrub pass in the digest builder, sources individually opt-in, shellHistory default-off.
- 8.3 short paths crashing native watchers: every watched path goes through `canonicalizePath` first, no exceptions.
