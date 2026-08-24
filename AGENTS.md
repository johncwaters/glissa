# glissa

This file is instruction-tier: conventions and invariants with their why, plus a lean map. Never restate what code shows. Feature rationale beyond an invariant one-liner does not belong here. Size is budget-gated by `tests/agents-md-size.test.js`.

## Purpose

Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions via node-pty, streams terminal output to a browser dashboard over WebSockets, derives session status from structural signals (Claude Code hooks plus an OSC-0 title fallback, never screen scraping), and notifies the operator through browser notifications.

## Architecture Map

What each entry owns, not how it works. A directory with its own `AGENTS.md` gets one row; read that file before working inside it.

| Path | Role |
|------|------|
| `server.js`, `vite.config.js` | Prod entry (wraps `server/backend.js`); frontend build plus dev attach plugin |
| `config.json`, `package.json`, `biome.json`, `socket.yml` | Dev config (installed: `~/.glissa/config.json`); package (`files` bounds the tarball), lint, scan policy |
| `DESIGN.md`, `DESIGN.json`, `PRODUCT.md` | Visual design system; product definition |
| `docs/`, `bin/` | Design docs, plans, postmortems; the npm CLI entry |
| `server/` | Backend runtime: Express/WS wiring, control plane, config, and every lane (`server/AGENTS.md` names the files) |
| `server/child-process-safe.js` | The ONLY module allowed to import `node:child_process` |
| `server/git-workspace.js` | The ONLY module allowed to run `git worktree` |
| `server/core/` | Pure decision modules for everything in `server/`, no IO |
| `session/` | Session domain: Session class, recorder, standalone relays (`session/AGENTS.md`) |
| `session/sessions.js` | Session class: lifecycle, PTY spawn/kill, timers, hooks, StatusSource |
| `session/adapters/`, `session/core/` | Per-agent adapters plus registry; pure cores from `sessions.js` |
| `detection/`, `notifications/` | Hook and title sources, settings injector, watchers, replay; notification lifecycle, outbox, channels |
| `packs/`, `shared/` | Version-controlled pack specs and sources; state constants shared by server (CJS) and browser (ESM) |
| `public/` | Browser dashboard, ES modules bundled by Vite (`public/AGENTS.md`) |
| `scripts/`, `tests/`, `test/` | Release scripts; the `node --test` suite; manual and container tests |
| `tools/`, `assets/`, `dist/` | Dev tooling; static assets; build output (gitignored, never edit) |

## For AI Agents

### Working In This Directory

- Server code is CommonJS only (`require` / `module.exports`); frontend is ESM bundled by Vite.
- Node >=22.16.0 (the `node:sqlite` FTS5 floor the memory store needs). Windows 11 and Linux, developed on v24.
- Do NOT add dependencies without explicit instruction.
- Status detection is structural (hooks plus OSC-0 title). Never reintroduce PTY body or content scraping.
- Spawn sessions with `pty.spawn`, never `child_process.spawn`, and never `shell: true`. Scrub env via `session/core/spawn-env.js`.
- All sessions share one event loop: no sync git or fs on recurring paths (polls, turn-end, watchers). Use async `execFile` with yields. One-shot cold paths may stay sync.
- Localhost-only trust boundary: never bind `0.0.0.0`, and keep the per-session bearer token check on `POST /hook/:glissaId/:event`.
- House character style: no literal em dash, en dash, ellipsis character, or emoji anywhere (source, tests, docs, commits). When code must emit one, build it via `String.fromCharCode`.
- Avoid `else`: prefer early returns and guard clauses.
- Prefer the seam pattern: pure logic in `session/core/` or a `*-core` module, thin IO shells around it. A pure core imports no Session and reads no clock.
- Inter-module communication via Node `EventEmitter`, not globals or direct coupling.
- Sessions are keyed by stable UUID `id`; `name` is display-only.

### Testing Requirements

- Run `npm test` (the `node:test` suite in `tests/`) before claiming completion.
- New pure logic gets a unit test; detection changes must also pass the replay fixtures (`tests/replay-harness.test.js`).
- Tests pin behavior better than prose: when a rule matters, add the test rather than a paragraph here.

### Common Patterns

- Dual WebSocket: data WS (`/terminals/:sessionId`, raw PTY bytes) and control WS (`/control`, JSON).
- Table-driven state machines (`session/core/state-machine.js`, `shared/notification-states.js`).
- Lane shape: pure rules in a core, deps injected into an IO-free poller, a thin wiring shell owning the timers.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Status Detection

- Machine signals only: hooks authoritative, OSC-0 title a fallback that never emits `awaiting-input`. Scraping the rendered TUI false-fires on redraw races (`session/core/status-mapper.js`, `docs/postmortem-terminal-detection.md`).
- A held `ready` is cancelled by `working`/`resume` in the conflict window, since resolving it fired a false COMPLETE after a fast re-prompt; `/clear` and `/compact` latch the title off likewise. `idle_prompt` is low confidence: it may only confirm quiescence from RUNNING.
- A main-agent `Stop` with background sub-agents running must NOT complete the card (`session/core/agent-tracker.js`, `gate-release.js`, `tests/sessions-detection.test.js`).
- A held ready releases on live evidence, never the count, sequence-ordered, its quiet window starting at the first evaluation that OBSERVES the drain (false COMPLETEs, 2026-08-14).
- Declared entries are TTL-bounded per kind: `shell`/`monitor` get no completion hook and an idle teammate is declared running forever, which pinned cards WORKING. Kill switch `detectBackgroundAgents`.

### Agent Adapters

- An adapter is TABLES and PURE FUNCTIONS: what varies between agent CLIs is vocabulary, and flags cannot express one (`docs/plan-agent-adapters.md`). `resolveCommand` is lazy and cached per id, or a `require` costs a PATH lookup.
- Key on `capabilities`, never `adapter.id`, which rots once a third agent shares a behavior with the first. An UNDECLARED capability is absent (`tests/agent-capabilities.test.js`).
- A relay hook forwards the envelope UNTOUCHED and exits 0 whatever happened, since a hook that fails must never fail its turn. Field aliasing stays server-side.
- The relay target rides `GLISSA_HOOK_URL` in the spawn env, never argv: a command line is readable by any local process, and an env target leaves an installed hooks file inert unsupervised.

### Session Spawning

- Claude CLI produces zero output with piped stdio, so a real PTY is required.
- Resolve-then-branch: a PE image spawns directly, a shim falls back to `cmd.exe /c`, avoiding cmd's double command-line parse and console-title write (`session/core/spawn-command.js`).
- The env scrub removes the Glissa marker vars, or Claude believes it is running inside itself.

### Auto-Resume and Shutdown

- The Claude session id is captured from WHICHEVER main-agent hook arrives: SessionStart does not reliably fire, and keying it there left boot auto-resume dead in production.
- It persists at HOOK time, not shutdown, which makes a hard kill lossless. Shutdown never writes config, since `wasActive` surviving IS the resume signal.
- No captured id means dormant; never guess with `--continue`. A stale id fails the session, flipping `wasActive` false, so there is no retry loop.
- Every lane's `stop()` is awaited under a bound, or a restart runs a fresh backend while the old one still writes the same state file; an overrunning lane is named and left behind. Cleanup waits for the killed PTY tree's reap, a surviving handle inside a worktree having failed the discard and leaked the checkout.

### Notifications

- Acknowledge the old entry BEFORE deciding the new one, or a WAITING to COMPLETE hop lands on a live DELIVERED entry and delivers nothing.
- Terminal categories fire once per WORK CYCLE, started only by a USER-driven RUNNING entry, so a lead waking N times per prompt fires once. `user_kill` is always silent.
- Focus suppression DEFERS, never drops, and is PER-CONNECTION: a global rule was right with one device and wrong once a paired phone existed. Zero connections never suppresses.
- Telegram pings are durable, browser notifications are not (operator ruling): a lost phone ping is unacceptable, a duplicate is a shrug. It gates on ZERO open control connections, not focus, an unfocused tab being what a browser notification is for.

### Worktree Auto-Rebase

- It rides the existing change funnel (no timer) and runs BEFORE the signature dedup, since a moved integration branch leaves the signature byte-identical. Every guard is pure in `session/core/rebase-gate.js`, and the guard ORDER is stated only by `tests/rebase-gate.test.js`.
- WAITING is the load-bearing exclusion: it is a permission prompt PAUSING a turn, and the agent resumes into the files an unattended rebase would have rewritten under it.
- `rebaseOnly` never stashes and merges nothing back: it runs unattended under a live agent, so a dirty tree is a hard refusal.
- A conflict is never escalated: the worktree is left byte-identical for the operator's own Merge. A cooldown key of both shas stops the retry loop; a sibling's resolution retriggers it.
- The completeness proof is "no unmerged paths remain". `git rerere remaining` may NEVER be one: it ignores binary conflicts, so continuing on its silence silently drops the commit (`tests/git-workspace-rebase.test.js`).
- Which paths rerere replayed is deliberately unreported: git clears `MERGE_RR` as it resolves, so any list would be a guess, and a guess in a forensic trace is worse than a silence.
- rerere config is seeded only when UNSET, an operator who disabled it meaning it. A rebase suppresses the change funnel while it runs, or the review gate self-heals to none mid-rebase.

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
- Wire-unit traps, normalized once in `public/usage-view-core.mjs`: `tokenLimit.pct` is a RATIO, not a percentage, and `scan.dirs` an ARRAY, not a count; face-value reads fail silently. Today is the SERVER's day, or a viewer in another zone reads the wrong bucket.
- Official plan limits OUTRANK the largest-block heuristic, and provenance is never implied: the heuristic is labelled estimated, and a stale snapshot shows its age rather than being swapped.
- The statusLine relay MUST chain the operator's own, since a per-session settings file REPLACES the global one and would delete their HUD; its POST is abandoned quickly to add no latency. The reply stays plain `{ ok, reason }`: `additionalContext` is UserPromptSubmit-only, and telemetry must never become a second injection point.

### Session Recording

- Signal-level recording is ON by default: the detection design is only debuggable after the fact, and an incident with it off costs a reconstruction, not one grep.
- Recordings land in `~/.glissa/recordings`, never cwd-relative, or an always-on recorder scatters files through whichever repo it was launched from.

### Context Packs

- Deterministic by contract, which lets the version be a hash and a rebuild diffable. It hashes every DELIVERED file, not just sources, or an edited rule rides out under an unchanged version.
- Budgets are hard gates and a failed build writes NOTHING, leaving the last good `current/` untouched. The always-loaded index has a tighter cap, the discovery tier being what context rot bites first.
- Both rebuild loops are CONSUMER-GATED, a docs tree worth packing being the one whose walk is expensive; `glissa pack build` stays always allowed, being how an operator inspects a pack. A newly assigned pack builds BEFORE the reload that recreates the session, or it lands after the spawn it exists for.
- The staleness notice is Glissa-AUTHORED only, never pack content, or the hook response becomes an injection relay; only an ACCEPTED callback may consume one.
- An unbuilt or unreadable pack is SKIPPED with a decision-trace entry: additive context must never block a spawn or guess a directory.
- A `data: true` source publishes outside the instruction tier, and the build FAILS if a data line appears in the index or under `.claude/rules/`: a build gate beats a convention.
- Per-project variants flatten into independent pack NAMES, so one version per pack still holds. A foreign project's slug in a delivered path fails the build.
- Sources are local files only: pack bytes land in permissionless sessions, so the boundary stays at files the operator already controls.
- Assignment is a DELTA message: the list is re-read inside the config write so two dashboards cannot clobber each other; only the added name is validated.
- A reload restarts a recreated session only if it was LIVE: starting a dormant card would spawn a session, with that project's permission setting, that nobody asked for.

### Long-Term Memory (plan: `docs/plan-visions-3.md`)

- Trust is stamped by the WRITE PATH, never read off the event; ranks fall but never rise along a lineage (`server/core/memory-core.js`).
- A user prompt becomes a `prompt` record, never projected and refused as knowledge, and its kind is absent from the ingest ring's table, so operator text reaches neither `dist/` nor the control WS.
- Memory alone never widens what leaves the machine: with the ingest lane off it builds its own source, and no ring, frame or digest sees those events.
- Expunging is THREE writes, all needed: `secure_delete` (a DELETE leaves plaintext greppable), an FTS5 rebuild (a delete only tombstones terms), and a WAL truncate checkpoint. Canary in `tests/memory-store.test.js`.
- A transcript-supplied timestamp is untrusted and clamped: a future-dated record lands in a segment retention can never prune and heads every recency ranking forever.
- A verdict is never trusted alone: the session answers with structured CLAIMS and Glissa renders the bytes, so no remembered byte reaches a file except through the renderer; a bad result is refused as ONE.
- Implied-rank rule: a rank may never exceed the highest among its cited records, and anything above `model` must cite one record and copy it verbatim, which makes verbatim locked facts mechanical.
- Net-new claims are capped and over the cap is an ERROR, a run inventing thirty facts at once being the failure this gate exists for. A canon past the prompt budget is refused rather than sliced, and a diff touching a LOCKED record is diverted to `dist-pending/`.
- Echo suppression closes the loop: delivered line hashes are registered and matching transcript lines dropped, so a session quoting its memory back is not re-ingested as fresh fact.
- One `contentMarker` PER untrusted corpus, so one fence cannot close another, and it is a sha256 digest rather than a cheap hash an attacker's text could fix-point.
- Nothing memory-shaped is deliverable over the control WS: no `memory-*` type, `config.memory` never settable or echoed, nothing in replay retention, no memory content in a lane log (`tests/memory-delivery-negative.test.js`).
- The direct-read pointer line in a repo's own `AGENTS.md` stays operator-authored: it is the one instruction-tier link in the chain, which keeps the store agent-agnostic.

### Ephemeral Lane Write Boundaries

- THE boundary is `defaultMode: acceptEdits` plus a throwaway cwd holding only the result file. Four plausible spellings fail SILENTLY, so every clause below comes from live probes recorded in `server/core/lane-permissions-core.js`.
- No lane may grant a bare `Write` allow, which is exactly what unbounds the writes, and nothing narrower grants the tool.
- A PATH DENY is not a write boundary: probed with a bare `Write` allow present, both spellings let the write through, and a rule that looks like a boundary and is not is worse than none.
- No lane may deny bare `Read`, `Write`, `Glob` or `Grep`: a bare `Read` deny refuses the Write tool, mutually exclusive with a result-file contract.
- The mode is set in the lane's managed settings file, overriding the operator's own, or `defaultMode: auto` leaves a classifier deciding these writes instead of a rule.

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

- The dual WebSocket split is deliberate: do NOT merge the channels. They want opposite loss policies (data drops recoverably and backfills by offset, control JSON must not drop), `bufferedAmount` is per-socket so one buffer cannot tell which stalled, and one stream would let a PTY flood block a kill frame.
- Control backpressure drops only what the next push repairs, and a type not listed as refreshable is never droppable, so a new frame cannot silently go stale under load.
- Both servers are heartbeat-reaped: focus suppression and the Telegram zero-connections gate COUNT open connections, so a half-open socket silently blocks the channel of last resort.
- Resize is arbitrated by ACTIVE VIEWER, not last write: one PTY has many viewers, and last-write-wins left a desktop stuck at a phone's column count forever.
- xterm.js handles ALL ANSI rendering; the server is a dumb pipe.

### Dashboard Layouts

- Two first-class layouts, not one responsive shell. `decideLayout` needs a coarse pointer AND a narrow viewport: a narrowed desktop window keeps the three-panel IA, and a coarse-pointer tablet has room for it. All phone styling keys off `[data-layout="phone"]`.
- Nothing is duplicated; live elements are RE-PARENTED into the phone screens and back, a second copy meaning a second state pipeline for the same facts. The card-borrow seam holds a GLOBAL single borrower, a session owning one xterm.
- Board order is attention-first, the opposite of the rail's stable identity order: a rail needs a fixed spatial map, a phone answers "who needs me". The "needs you" RULE lives once, in `public/focus-view/attention-core.mjs`.
- Touch scroll is ours because xterm 6.0.0 has no touch path at all. The alternate buffer re-emits the drag as synthetic wheel notches so xterm's OWN listeners decide the meaning.
- Predictive text bypasses xterm's input path on PHONE ONLY: xterm 6.0.0 mishandles autocorrect events (upstream `xtermjs/xterm.js#3600`, open). Desktop is untouched, where the same takeover would regress CJK composition.

## CSS Convention

- Tailwind utility classes for static markup in `index.html`; semantic classes in `style.css` for JS-created DOM.
- State-driven styles via `[data-state]` selectors; layout branches via `[data-layout]`.
- Animations and pseudo-elements live in `style.css`; theme tokens in `public/tailwind.css` via `@theme`, applied by `public/theme.js`.

## Coding Style

- CommonJS only on the server: `const x = require('x')`, `module.exports = { ... }`.
- No classes unless the pattern genuinely requires instance state.
- Prefer explicit over clever; keep functions small and single-purpose.
- Propagate errors via EventEmitter `error` events or callbacks, not thrown exceptions in async paths.
- Comments are a last resort and carry only the why.

## Development Workflow

- `npm run dev` - Vite dev server with HMR on 5173, backend attached via plugin (one process)
- `npm run dev:server-only` - Express backend only on 3000
- `npm run build` / `npm start` - production bundle to `dist/`; production server
- `npm test` - the `node:test` suite; `npm run test:container` adds the Docker remote-mode run

## Platform and Runtime

Windows 11 (Linux supported), Node v22.16.0 or later, developed on v24. CommonJS on the server, ES modules in the browser bundled by Vite.

## Dependencies

Runtime: `express`, `ws` (no Socket.IO and no abstraction over WebSockets, ever), `node-pty` (a real PTY; needs C++ build tools, VS Build Tools on Windows), and browser-only `@xterm/xterm` with `addon-fit` and `addon-webgl`.

`@parcel/watcher` backs the fs ingest source only, chosen because it applies ignores BEFORE watch registration, which keeps a `node_modules` tree from exhausting `inotify.max_user_watches` on Linux. A load failure disables that one source and nothing else.

Dev: `vite`, `tailwindcss` v4 with `@tailwindcss/vite`.

## Parallel Agent Work

Fanning out multiple agents over this repo: give each its own git worktree and integrate the lane back once it is clean, so concurrent lanes cannot collide in the working tree. A convention for editing Glissa, not a runtime feature.
