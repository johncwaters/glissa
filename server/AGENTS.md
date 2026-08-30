<!-- Generated: 2026-07-03 -->

# server

## Purpose
Backend runtime: the Express + WebSocket server factory and its control plane, plus shared server plumbing (config store, scheduler, spawn gate, WS sender, post-turn checks, safe child-process wrapper).

## Key Files

| File | Description |
|------|-------------|
| `backend.js` | Express + WebSocket server factory |
| `backend-*.js` | Wiring extracted from the factory, one concern per file |
| `session-{factory,registry,event-wiring}.js` | Session construction, config reconciliation, and one-time event wiring |
| `control-handlers.js` | Control-WebSocket message handlers (kill, restart, rename, settings) |
| `control-replay-core.js` | Pure control-broadcast replay log |
| `server-lifecycle.js` | Boot/shutdown helpers; restart strategy in `core/restart-strategy.js` |
| `ws-sender.js` | Data-WebSocket sender: batching and backpressure |
| `post-turn-checker.js` | Post-turn hygiene IO runner (rules in `session/core/post-turn-rules.js`) |
| `usage-wiring.js` | Usage lane IO shell |
| `usage-scanner.js` | Claude Code transcript scanner |
| `usage-pricing.js` | Claude model pricing loader |
| `data/claude-pricing.json` | Bundled LiteLLM pricing snapshot |
| `spawn-gate.js` | Process-wide async serialization of `pty.spawn` initiation (ConPTY wedge avoidance) |
| `git-workspace.js` | THE ONLY module allowed to run `git worktree` (`tests/no-direct-git-worktree.test.js`) |
| `config-store.js` | Runtime config load/save/defaults |
| `child-process-safe.js` | THE ONLY importer of `node:child_process` (`tests/no-direct-child-process.test.js`) |
| `update-check.js` | Startup release-tag check, advisory only |
| `pr-review-wiring.js` | PR auto-review IO shell |
| `ephemeral-session.js` | Shared ephemeral-Session registration and cleanup |
| `pr-poller.js` | PR auto-review poller (opt-in), IO-free |
| `pr-gh.js` | `gh`/`git` wrappers for the PR poller |
| `pr-telegram.js` | PR-only Telegram push helper (never throws; NOT a `NotificationManager` channel) |
| `core/pr-review-core.js` | Pure PR-review decisions |
| `core/branch-sync-core.js` | Pure ahead/behind decisions for the branch-sync indicator |
| `core/restart-strategy.js` | Pure restart strategy, keyed on systemd's `INVOCATION_ID` |
| `core/upgrade-route.js` | Pure WS-upgrade target classification by PATHNAME |

## For AI Agents
- These modules live one level below the repo root: filesystem assets (`dist/`, `public/`, `config.json`, `node_modules/`) resolve via `path.join(__dirname, '..', ...)`. Keep that offset when adding paths.
- CommonJS only; no new dependencies without explicit instruction; avoid `else` (guard clauses).
- See root `AGENTS.md` for architecture and conventions.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Worktree Auto-Rebase

- It rides the existing change funnel (no timer) and runs BEFORE the signature dedup, since a moved integration branch leaves the signature byte-identical. Every guard is pure in `session/core/rebase-gate.js`, and the guard ORDER is stated only by `tests/rebase-gate.test.js`.
- WAITING is the load-bearing exclusion: it is a permission prompt PAUSING a turn, and the agent resumes into the files an unattended rebase would have rewritten under it.
- `rebaseOnly` never stashes and merges nothing back: it runs unattended under a live agent, so a dirty tree is a hard refusal.
- A conflict is never escalated: the worktree is left byte-identical for the operator's own Merge. A cooldown key of both shas stops the retry loop; a sibling's resolution retriggers it.
- The completeness proof is "no unmerged paths remain". `git rerere remaining` may NEVER be one: it ignores binary conflicts, so continuing on its silence silently drops the commit (`tests/git-workspace-rebase.test.js`).
- Which paths rerere replayed is deliberately unreported: git clears `MERGE_RR` as it resolves, so any list would be a guess, and a guess in a forensic trace is worse than a silence.
- rerere config is seeded only when UNSET, an operator who disabled it meaning it. A rebase suppresses the change funnel while it runs, or the review gate self-heals to none mid-rebase.

### Worktree Base Branch

- The base is the configured integration branch, or each repo's default branch when unset. Origin is the source of truth: initial creation and fresh restart sync it fast-forward-only without blocking spawn, merge-back syncs it before landing and pushes it after, and a diverged base is never touched automatically (`tests/git-workspace-integration-sync.test.js`, `tests/git-workspace-session.test.js`, `tests/sessions-worktree.test.js`).

### Remote Branch GC

- Remote cleanup is default-on and opts out only through `branchGc.enabled: false`; it is confined to `glissa/session/`, protects every configured session id, and otherwise requires merge proof or orphan staleness, so unattended cleanup cannot become branch loss (`server/core/branch-gc-core.js`, `tests/branch-gc-core.test.js`).

### GitHub PR Auto-Review (opt-in)

- Inert unless both `config.prReview.enabled` and `config.telegram` are set. A clean PR is reviewed IN PLACE (diff only) so it coexists with a live session in the repo; a conflicting one gets a worktree, discarded on every exit path.
- Only the POLLER merges; the agent never does. The verdict travels via a result file, since `gh pr review` 422s on your own PR, and a missing one reads as ERROR, never a false clean.
- Every merge gate fails CLOSED: reviewed head must equal current head, checks must be green (no checks is never green), and a `gh` error on the workflow-files query defers a tick (`server/core/pr-review-core.js`).
- All `gh` and `git` go through `child-process-safe` and `git-workspace` (`tests/no-direct-child-process.test.js`, `tests/no-direct-git-worktree.test.js`).

### Radar / PostHog Auto-Fix (opt-in)

- The agent COMMITS; the server pushes and opens the PR. `FIX_DENY` denies `git push` and `gh` outright, since a prefix deny-list cannot constrain a push TARGET or a merge API call.
- The server REFUSES the handoff when the diff touches `.github/workflows/`, making "never touches CI" structural; the PR url comes from `gh` stdout, never the agent.
- Nothing here merges. With `prReview.enabled` also on, unattended code can reach the base branch with no carbon unit in the loop; the operator opts into that knowingly.
- The branch name carries a random discriminator: a deterministic one collides with a previous fix's pushed branch, burning the timeout on a regression after a fix.

### Usage Tracking

- Costs are estimates against list price, not bills, over local transcripts only. Only a COMPLETE scan pass writes the warehouse or evaluates budgets: a partial pass would store an undercount as durable truth and burn a once-per-period alert.
- The warehouse exists because Claude Code deletes transcripts after about 30 days; it extends the DAILY series only. Live wins inside live coverage, history fills in only behind it and is labelled: a day Glissa remembers is a different claim from one it can still see.
- Lane attribution is EXACT, never inferred: a session counts only because Glissa recorded spawning it, everything else is `other`. Guessing from a cwd would mis-bill a lane.
- The ledger (`usage-lanes.json`) is keyed by a VENDOR-NAMESPACED composite `<vendor>:<sessionId>`, the same shape the scanner's dedup uses, so a codex id cannot collide with a claude one now that Glissa supervises both; a pre-M5 file keyed `claudeSessionId` round-trips as vendor `claude`. It is written from the `claude-session-id` event (name kept for wire/back-compat; payload now carries `{ vendor, sessionId }`, `vendor` from the session's adapter `usageVendor`).
- A supervised codex/grok card attributes to its lane and shows its own token/cost chip, joined by the card's captured session id against that vendor's transcript entries (the scanner already parses them). Blocks, burn rate and plan limits stay Claude-only and labelled as such: they are subscription concepts, so mixing another vendor's tokens in would misread a plan window.
- Wire-unit traps, normalized once in `public/usage-view-core.mjs`: `tokenLimit.pct` is a RATIO, not a percentage, and `scan.dirs` an ARRAY, not a count; face-value reads fail silently. Today is the SERVER's day, or a viewer in another zone reads the wrong bucket.
- Official plan limits OUTRANK the largest-block heuristic, and provenance is never implied: the heuristic is labelled estimated, and a stale snapshot shows its age rather than being swapped.
- The statusLine relay MUST chain the operator's own, since a per-session settings file REPLACES the global one and would delete their HUD; its POST is abandoned quickly to add no latency. The reply stays plain `{ ok, reason }`: `additionalContext` is confined to the adapter-declared pack-notice hook, and telemetry must never become a second injection point.

### Long-Term Memory (plan: `docs/plan-visions-3.md`)

- Trust is stamped by the WRITE PATH, never read off the event; ranks fall but never rise along a lineage (`server/core/memory-core.js`).
- A user prompt becomes a `prompt` record, never projected and refused as knowledge, its kind absent from the ingest ring's table, so operator text reaches neither `dist/` nor the control WS.
- Memory alone never widens what leaves the machine: with the ingest lane off it builds its own source, and no ring, frame or digest sees those events.
- Expunging is THREE writes, all needed: `secure_delete` (a DELETE leaves plaintext greppable), an FTS5 rebuild (a delete only tombstones terms), and a WAL truncate checkpoint. Canary in `tests/memory-store.test.js`.
- A transcript-supplied timestamp is untrusted and clamped: a future-dated record lands in a segment retention can never prune and heads every recency ranking forever.
- A verdict is never trusted alone: the session answers with structured CLAIMS and Glissa renders the bytes, so no remembered byte reaches a file except through the renderer; a bad result is refused as ONE.
- Implied-rank rule: a rank may never exceed the highest among its cited records, and anything above `model` must cite one record and copy it verbatim, which makes verbatim locked facts mechanical.
- Net-new claims are capped, a run inventing thirty facts at once being what that gate exists for. A run reads only the delta above a durable `seq` cursor and MERGES into the standing claims: replacing them made the canon one prompt, refusing every run. Age SKIPS work and never causes it: past `staleHorizonDays` the delta steps over a record AND the cursor moves with it, or that tail replays forever. A LOCKED diff still diverts to `dist-pending/`.
- Echo suppression closes the loop: delivered line hashes are registered and matching transcript lines dropped, so a session quoting its memory back is not re-ingested as fresh fact.
- A tool call is activity, not a fact: `agent-tool` left the ingest kind table at 53% of the canon, `Bash` lines a run paid to read.
- One `contentMarker` PER untrusted corpus, so one fence cannot close another, and it is a sha256 digest rather than a cheap hash an attacker's text could fix-point.
- Only memory TOGGLES cross the control WS: settings are an allow-list of booleans and clamped ints, so no `memory-*` type, path, record or lane log line rides one, a knob being tunable where a filename would be a leak (`tests/memory-delivery-negative.test.js`).
- The ceiling on a delivered projection is BYTES per project, not claims: a count bounds nothing an operator feels, so a project over `maxProjectChars` is compacted by a model first and evicted down to fit if that declines, never dropping a locked claim and never emptying a project (`server/core/memory-distill-core.js`).
- `deadend` is a projected kind of its own because retiring a failed attempt forgets it and the next session proposes it again; it stands until a record shows the approach working.
- The direct-read pointer line in a repo's own `AGENTS.md` stays operator-authored: it is the one instruction-tier link in the chain, which keeps the store agent-agnostic.
- An intent record names its thread as a `thread <id>: ` text prefix, never a column: chains are keyed by project AND thread (`latestIntentHeads`), and the id shape has ONE definition, `VISIONS_THREAD_ID_PATTERN` in `shared/visions-intent-ids.js`, which the server cores and the browser decoder both build their regex from, short enough that the entropy screen can never refuse it.

### Ephemeral Lane Write Boundaries

- THE boundary is `defaultMode: acceptEdits` plus a throwaway cwd holding only the result file. Four plausible spellings fail SILENTLY, so every clause below comes from live probes recorded in `server/core/lane-permissions-core.js`.
- No lane may grant a bare `Write` allow, which unbounds the writes, and nothing narrower grants the tool.
- A PATH DENY is not a write boundary: probed with a bare `Write` allow present, both spellings let the write through, and a rule that looks like a boundary and is not is worse than none.
- No lane may deny bare `Read`, `Write`, `Glob` or `Grep`: a bare `Read` deny refuses the Write tool, mutually exclusive with a result-file contract.
- The mode is set in the lane's managed settings file, overriding the operator's own, or `defaultMode: auto` leaves a classifier deciding these writes instead of a rule.
- A lane prompt is written in its throwaway cwd and invoked by a constant bootstrap argument, since a Windows `.cmd` shim re-parses argv through `cmd.exe` (`server/visions-dispatch.js`, `server/pack-distiller.js`).

### Security: Trust Boundary

- Glissa binds localhost only. Any local PROCESS is trusted; it is deliberately NOT "any local web page", and three layers keep a page on another local port out of the control WS.
- Host allow-list first (`server/core/host-policy.js`). An ABSENT Host passes, since rebinding always carries a name and refusing it would only break HTTP/1.0 clients.
- Port-exact Origin, the port read from the socket so nothing a client sends decides it; a mismatch falls THROUGH to the allow-list. Browser channels demand an Origin, non-browser ingresses do not.
- A per-process page token guards local control and data upgrades, riding the query string since a browser cannot set a WS handshake header. `GET /control-token` refuses a disallowed Origin outright.
- Trust is the LISTENER PORT, never a header or IP: a reverse proxy makes remote traffic look loopback, so an IP or `X-Forwarded-For` rule would hand every visitor local trust (`tests/request-trust.test.js`).
- A pairing cookie is RCE as the server account, the control WS accepting any project path plus `dangerouslySkipPermissions`. Pairing URLs are single-use, short-TTL, never logged or stored in plaintext; the store fails CLOSED on corruption.
- The `/pair/*` exemption is judged on the DECODED pathname: `express.static` resolves dot segments, so an un-normalized check served the dashboard bundle under `/pair/%2e%2e/`.
- Remote config is unreachable from the control WS, and remote-off is fully inert: no route, no middleware, no file (`tests/backend-remote-disabled.test.js`). Binding wider needs `GLISSA_INSECURE_BIND=1`.
- Two HTTP write ingresses. `POST /hook/:glissaId/:event` keeps its per-session bearer token, and its RESPONSE is also an ingress, so only Glissa-authored text may be injected. `POST /upload/:sessionId` sits behind remote-auth with a type and size cap.
- If network exposure is ever needed, add authentication to the control WebSocket first.

### Transport and Session Identity

- The dual WebSocket split is deliberate: do NOT merge the channels. They want opposite loss policies (data drops and backfills by offset, control JSON must not drop), `bufferedAmount` is per-socket so one buffer cannot tell which stalled, and one stream would let a PTY flood block a kill frame.
- Control backpressure drops only what the next push repairs, and a type not listed as refreshable is never droppable, so a new frame cannot silently go stale under load.
- Both servers are heartbeat-reaped: focus suppression and the Telegram zero-connections gate COUNT open connections, so a half-open socket silently blocks the channel of last resort.
- Resize is arbitrated by ACTIVE VIEWER, not last write: one PTY has many viewers, and last-write-wins left a desktop stuck at a phone's column count forever.
- xterm.js handles ALL ANSI rendering; the server is a dumb pipe.
