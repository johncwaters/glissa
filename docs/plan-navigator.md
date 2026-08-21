# Plan: Navigator (real-time AI pair navigator)

Status: drafted 2026-08-20; M1 to M5 shipped. `AGENTS.md` and the code win over this doc, and superseded sections move to `docs/archive/` per convention.

## What this is

A lane that watches live editor buffers while a carbon unit types (code or prose) and responds like a pair-programming navigator: it comments, flags, and suggests, it does not take the keyboard. It fills the gap between autocomplete (keystroke scale) and one-shot agents (task scale).

Feedback is tiered by severity, and the tier decides the surface:

| Tier | Meaning | Surface |
|------|---------|---------|
| 1 | Silent fix: typos, trivial mechanical corrections | LSP code action / workspace edit, always undoable, logged in the Navigator tab |
| 2 | Semantic lint: contradiction, missed case, reuse miss | LSP publishDiagnostics (squiggles in the editor) |
| 3 | Suggestion or direction, offered at a natural boundary | Navigator tab comment card, never inside the editor |
| 4 | Raised hand: something structural looks wrong | Navigator tab indicator; the carbon unit pulls when ready |

Rules the tiers enforce: the navigator never moves the cursor, never inserts text unrequested above tier 1, and tier 3+ output waits for a pause boundary (typing quiet, blank line, save, test run), never mid-word. Findings age out when the buffer moves past them; stale annotations are dropped, not accumulated.

Alongside the tiers the navigator maintains an intent model: a short living statement of what it believes the carbon unit is building ("blog post arguing X for audience Y", "refactor of the spawn path to remove the cmd.exe hop"). It renders in the Navigator tab and is directly correctable there. Feedback quality is downstream of intent accuracy, so correcting the intent doc replaces prompt writing.

## Markdown and prose are first-class targets

LSP is filetype-agnostic: `didChange` carries text for whatever language id the editor attaches the server to, so markdown needs nothing special, only editor config mapping the `markdown` language id to the relay. Shipping precedent: marksman (markdown structure LSP), ltex-ls (LanguageTool grammar diagnostics over LSP), and grammarly-languageserver (Grammarly's official LSP server) all serve prose feedback through this exact transport today. Editors attach multiple servers per filetype, so the navigator runs beside them without conflict.

Dogfood scenario, and the first real target: plan-doc review. A Claude session drafts a `docs/plan-*.md`, the carbon unit edits it in their editor, and the navigator watches the edits live: tier 2 when an edit contradicts another section, tier 3 when a milestone's acceptance criteria get weakened, intent model reading "reviewing the navigator plan, tightening scope". The navigator's own plan docs are the test corpus.

## Decision: where the LSP boundary lives (shim vs native vs rewrite)

Something must speak LSP over stdio, because stdio is the transport every editor supports (VS Code, Neovim, Helix, Zed, JetBrains via plugin) and the only one Helix supports at all. Editors spawn their language server as a child process; they cannot spawn the Glissa daemon (single instance, already running), and socket-transport LSP support is uneven across editors. A separate spawned process at the editor boundary is therefore required by LSP's own topology. The design question is what that process is allowed to know.

Considered:

1. **Fat shim.** LSP handling, buffer state, and debounce in the shim; results forwarded to Glissa for display. Rejected: this is the bandaid version. State lives in N shim processes, dies with each editor, diverges from the daemon, and none of Glissa's pure-core test discipline can reach it.
2. **Native socket LSP, no shim.** The daemon exposes LSP over TCP and editors connect directly. Rejected: Helix cannot, per-editor config diverges, and the Vite dev restart severs every editor's LSP session with no process left behind to resync it.
3. **Rewrite: a separate navigator daemon (Rust/Go) beside Glissa.** Rejected: Glissa already is the long-lived daemon, with sockets, wiring seams, ephemeral Claude sessions, usage attribution, and a tab system; a second daemon duplicates all of that to avoid one WS forward. Node is not the bottleneck: tsserver and Copilot's language server are both Node, and didChange byte volume is far below the PTY streams Glissa already moves.

**Decision: transport-only shim, brain in the daemon.**

- The shim (`session/navigator-relay.js`, following the `statusline-relay.js` precedent: a standalone process Glissa code never requires) speaks LSP stdio with the editor and forwards frames over a loopback WS to the daemon. It makes zero navigator decisions.
- The one state it holds is a mirror of open documents (uri, version, text), maintained by applying didChange locally, solely so it can replay didOpen snapshots when the daemon connection drops and returns (the Vite dev-restart case; LSP has no server-initiated "resend everything" request, so the editor cannot be asked). Replay is mechanical, still transport.
- Everything else lives in the daemon: protocol interpretation, buffer store, debounce, tier engine, intent model, model dispatch, persistence.

This is not a bandaid by the project's own standard: the shim is an adapter at a protocol boundary, the same role `statusline-relay.js` plays for the statusLine channel, with all logic behind it in testable pure cores.

## Architecture

```
editor A --LSP stdio--> navigator-relay --WS /navigator--> Glissa daemon
editor B --LSP stdio--> navigator-relay --WS /navigator-->   |
                                                             |-> navigator engine (debounce, tiers, intent)
                                                             |-> ephemeral claude -p sessions (tier 3/4 thinking)
                                                             |-> Navigator tab (control WS broadcasts)
                                                             <-- diagnostics / code actions back down the same WS
```

Module placement, following existing seams:

| Module | Role |
|--------|------|
| `session/navigator-relay.js` | Standalone LSP stdio shim, spawned by editors, never required by the server |
| `server/navigator-wiring.js` | IO shell: WS route hookup, engine lifecycle, claude dispatch, broadcasts (mirrors `usage-wiring.js`) |
| `server/core/navigator-lsp-core.js` | Pure LSP framing and message classification (Content-Length framing is small; no new dependency) |
| `server/core/navigator-buffer-core.js` | Pure document store ops: apply didChange deltas, version ordering, snapshots |
| `server/core/navigator-pause-core.js` | Pure pause/boundary detection: quiet windows, blank line, save (reuses the `watch-debounce.js` timer half where it fits) |
| `server/core/navigator-tier-core.js` | Pure tier ladder: classify a finding into tiers 1 to 4, dedupe against standing findings, age-out rules |
| `server/core/navigator-intent-core.js` | Pure intent-model state: current statement, staleness, merge of carbon-unit corrections |
| `public/navigator-panel.js` | Navigator tab: comment cards, raised hand, intent doc editor, tier 1 changelog; one `VIEW_TABS` entry |

Wire and trust:

- New WS route `/navigator` classified in `core/upgrade-route.js`, local listener only, same trust as the control WS (which can already spawn permissionless sessions, so buffer content adds no new class of local exposure). Refused on the remote listener in v1.
- Keystroke deltas never ride `/control` (16KB cap, JSON broadcast to every client). The `/navigator` socket is shim-to-daemon only. UI updates to the tab ride `/control` as small JSON (comment cards, intent text, counts), which fits its size and replay semantics.
- Diagnostics and code actions flow daemon -> shim -> editor over the same `/navigator` socket, so the editor-facing tiers work in every LSP client with zero per-editor code.
- Buffer text stays in memory: never written to recordings, the warehouse, or any file in v1.

Model dispatch:

- No continuous model pass. The engine runs on pause boundaries only; every model call is explicit and debounced.
- Tier 3/4 thinking runs as ephemeral headless `claude -p` sessions through `registerEphemeralSession` with lane id `navigator`, which buys usage attribution ("the navigator cost $X this week") for free, the same way the pr-review and posthog lanes get it. A session receives the buffer snapshot, the intent model, and the standing findings, and returns a result-file verdict like the PR lane (never a free-text parse).
- Tier 1/2 in v1 is rule-based only (pure detectors in the `slop-code-patterns.js` style), so the editor-facing loop has zero latency and zero cost. Model-generated tier 2 is a later question, not a v1 commitment.

Config:

- `config.navigator`, absent by default and then fully inert: no route mounted, no wiring constructed, byte-identical behavior, matching the `prReview` pattern. v1 keys: `enabled`, dispatch budget caps. Per-project scoping comes later.

## One engine cycle

1. didChange frames update the buffer store (pure apply, version ordered).
2. The pause detector fires on a boundary (typing quiet for N ms, blank line, save).
3. Rule-based detectors sweep the changed region; tier 1/2 findings go out immediately via LSP.
4. When the changed region crosses a threshold (new paragraph or function, or M minutes since the last pass), a navigator claude session is dispatched with buffer, intent, and standing findings; its result file yields tier 3/4 findings and an updated intent statement.
5. The tier core dedupes against standing findings, ages out stale ones, and broadcasts tab updates.

## Milestones and acceptance (each ships with `node --test` coverage)

- **M1 transport.** The relay speaks initialize/didOpen/didChange/didClose with a real editor and the daemon mirrors buffers. Tests: `navigator-lsp-core` framing fixtures, `navigator-buffer-core` delta application, relay reconnect replay against a restarted fake daemon.
- **M2 tier 2 loop.** Rule-based findings render as squiggles in VS Code and Neovim from the same daemon. Tests: tier-core classification and dedupe; wiring publishes diagnostics for a scripted didChange sequence.
- **M3 tab (shipped, findings half).** Navigator tab renders live findings, one section per open uri; `VIEW_TABS` entry, desktop only (the phone layout hides the tab strip, so no phone screen borrows the panel in v1). The intent doc moved to M5, which is where intent state is built. The replay-retention decision went the other way than "add a type to the list": findings are current state per buffer, not the one-shot moments `control-replay-core.js` retains, so `navigator-findings` stays off that list and a connecting client is repaired with one `navigator-snapshot` of the whole map (the `plan-limits` precedent). A relay disconnect keeps the map, because the shim replays its buffers on reconnect; `didClose` clears the uri and says so. Tests: `tests/navigator-wiring.test.js` (broadcast shape, clear on close, snapshot accessor, disconnect retention), `tests/navigator-tab.test.js` (real control WS repair end to end, retention rule), `tests/frontend-navigator-view.test.js` (grouping, ordering, wording).
- **M4 model dispatch (shipped).** A pause boundary dispatches one ephemeral headless `claude -p` session per document, which answers with tier 3 comment cards in the Navigator tab. Verified end to end against a fixture buffer: comments broadcast as `navigator-comments`, and the lane ledger gained its `navigator` row with no ledger code of its own (`registerEphemeralSession` already knows both the lane and the session id).
  - **The gate is the product.** `server/core/navigator-dispatch-core.js` decides; the wiring only obeys. A published sweep arms a per-document quiet window (`quietMs`, default 30s) and any edit restarts it; a save evaluates the same gate immediately. The gate passes only when nothing is in flight (concurrency 1, gated and never queued), the document's text hash differs from its last dispatched one, its per-document cooldown has elapsed (`cooldownMs`, default 5m), and the machine-wide trailing-hour count is under `maxPerHour` (default 6). A refusal costs one log line naming the gate that held.
  - **Config: `config.navigator.dispatch`,** config-file only like `config.navigator` itself, and absent means fully inert: no dispatcher is constructed, no dispatch timer is ever armed, nothing can spawn (pinned by test). Keys: `enabled` (exactly `true`), `quietMs`, `cooldownMs`, `maxPerHour`, `activityMaxPerHour` (default 2, the share of `maxPerHour` an activity-driven dispatch may spend, clamped to at most `maxPerHour - 1`, and `0` turns activity-driven dispatch off; see docs/plan-ingestion.md, M7.5), `dispatchTimeoutSeconds` (default 180), `model` (optional, appended as `--model`).
  - **Permissions posture: narrow allow, NOT skip-permissions.** The prompt embeds arbitrary buffer text, so the session spawns as `-p --allowedTools=Write` with a deny list of `Bash`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Task`, and its cwd is a fresh empty temp dir that is deleted with the dispatch. Three findings came out of probing the real CLI rather than assuming: `--allowedTools` is VARIADIC, so the spaced form swallows the prompt positional and claude exits with "Input must be provided ... when using --print" (hence the `=` form); a deny rule covering a path blocks WRITING that path too, so denying `Read` and keeping the result-file contract are mutually exclusive and `Read` is deliberately not denied; and path-scoped allow rules do not narrow a file write at all (only `Edit(path)` rules are matched by file permission checks), so the throwaway cwd, not a rule, is what keeps writes away from a repo. Net: no shell, no network, no sub-agents, no repo edits, and reads that go nowhere because nothing can send them anywhere.
  - **The result is a file, never free text.** The session writes one JSON file: `{ verdict: 'COMMENTS' | 'NONE' | 'ERROR', comments: [{ line, message }] }`, at most 5 comments, each message capped at 300 characters. Missing, unparsable, non-object or unknown-verdict is an ERROR that is logged and changes nothing, and every surviving comment is validated (a finite 1-based line inside the buffer that was sent, a non-empty trimmed message) with invalid entries dropped rather than shown. A timeout aborts the session and reads as ERROR.
  - **State and surface.** Comments are stored per uri beside the findings, replaced wholesale by each dispatch, cleared on `didClose`, and the connect-time `navigator-snapshot` carries both halves (`comments` is an additive field). The tab renders them as cards under their document, visually distinct from the tier 2 finding rows, and they raise the tab's activity dot the same way findings do.
  - Tests: `tests/navigator-dispatch-core.test.js` (each gate, the hash rule, the trailing-hour window, the result validation, the prompt), `tests/navigator-dispatch.test.js` (result-file contract, hard timeout, work-dir cleanup, the permissions posture pinned), `tests/navigator-wiring.test.js` (quiet window, re-arm on edit, save boundary, cooldown/unchanged/in-flight/hour-cap gates, broadcast and snapshot, close clears, the inert-default pin), `tests/frontend-navigator-view.test.js` (both-halves grouping and wording). No test spawns claude.
- **M5 intent model (shipped).** A correction round-trips from the tab into the next dispatch: the Navigator tab renders one living statement of what the navigator believes is being built, the tier 3 prompt carries it as context, and a dispatch result can propose a new one.
  - **The merge is the product, again.** `server/core/navigator-intent-core.js` decides; the wiring only obeys. State is `{ text, source: 'model' | 'operator', locked, ts }`, empty to start. A MODEL proposal (a dispatch result's optional `intent`) replaces the statement only while it is unlocked, and a model with nothing to say never clears one. An OPERATOR correction sets the text, takes the source, and LOCKS it, so no later proposal can overwrite it: the lock is enforced at the merge, which is why no caller has to remember it. An operator submitting EMPTY text clears the statement entirely and unlocks, which is how control is handed back to the model. Both paths sanitize the same way (strings only, trimmed, capped at 300 characters), a merge that lands where it started is not a change and so costs no broadcast, and staleness is DERIVED (`ageMs(state, now)`), never stored.
  - **Scope: machine-wide and in memory.** One statement per daemon, not one per uri, because it describes what the carbon unit is doing rather than what a buffer contains. v1 persists nothing: a daemon restart resets the intent to empty, and the model proposes a fresh one on its next pass. Durable intent is a later question, not a v1 commitment.
  - **Surface and wire.** The lane broadcasts `navigator-intent` (`{ text, source, locked, ts }`) whenever the statement actually moves, and the connect-time `navigator-snapshot` carries it as an additive `intent` field. The tab renders the statement, a source-and-age line ("set by you" vs "proposed by navigator"), and one field plus a constant `Set intent` button; the correction rides the control WS as `navigator-set-intent`, whose handler validates and delegates (an absent lane refuses like every other absent-lane handler). The result-file contract gained an OPTIONAL `intent` string, validated exactly like a comment message (string, trimmed, capped, invalid ignored) and applied AFTER the comments so a locked statement is never disturbed by a dispatch.
  - Tests: `tests/navigator-intent-core.test.js` (every merge rule, lock semantics, empty-clears-and-unlocks, sanitization, derived age), `tests/navigator-wiring.test.js` (proposal broadcast, locked rejection broadcasting nothing, snapshot intent, the intent riding a dispatch and its result landing after the comments), `tests/navigator-dispatch.test.js` and `tests/navigator-dispatch-core.test.js` (the optional result field, the prompt block present and cleanly absent), `tests/control-navigator-intent.test.js` (the correction case including the lane-off refusal), `tests/frontend-navigator-view.test.js` (source, age and changed-state wording), `tests/navigator-tab.test.js` (a correction over a real control WS surviving a faked dispatch and riding the snapshot repair).

Doc gate: the checkable claims in this plan are the milestone tests named above. As milestones land, their sections graduate into `AGENTS.md` and this doc heads to `docs/archive/`.

## Running the MVP (M1 + M2, shipped)

1. Enable the lane in config.json: `"navigator": { "enabled": true }` (config file only, not control-WS settable, restart Glissa).
2. Point an editor's LSP client at the relay for markdown. Neovim 0.11+:

```lua
vim.lsp.config['glissa-navigator'] = {
  cmd = { 'node', 'C:/Users/johnw/Projects/glissa/session/navigator-relay.js', '--port', '5173' },
  filetypes = { 'markdown' },
}
vim.lsp.enable('glissa-navigator')
```

Helix (languages.toml):

```toml
[language-server.glissa-navigator]
command = "node"
args = ["C:/Users/johnw/Projects/glissa/session/navigator-relay.js", "--port", "5173"]

[[language]]
name = "markdown"
language-servers = ["marksman", "glissa-navigator"]
```

Use `--port 5173` against `npm run dev` and `--port 3000` against `npm start`; with no flag the relay tries both. VS Code has no native generic LSP client, so it needs a thin extension wrapping vscode-languageclient: deferred, tracked as part of M2's remaining scope, and the reason M2 is not fully closed by the MVP.

3. Type a repeated word in any .md file; a warning squiggle appears about 300ms after you pause. Stop the daemon and restart it mid-edit: the relay reconnects and replays open buffers.

## Non-goals (v1)

- No own editor, no Electron surface, no browser extension (prose in hosted editors waits).
- No PTY or screen scraping, ever: buffers arrive only via LSP.
- No remote-listener exposure of `/navigator`.
- No autocomplete: ghost text is Copilot's job, not this lane's.

## Risks

- **Vite dev restart severs the `/navigator` socket.** Relay reconnect plus didOpen replay is the designed answer; it is tested in M1, not discovered late.
- **Cost runaway.** Every model dispatch is pause-gated and budget-capped, and visible per lane in the Usage tab through the existing budget machinery.
- **Noise.** Tier discipline is the product. A tier 3 comment that fires mid-flow teaches the carbon unit to disable the lane and never return; pause-boundary gating is a correctness requirement, not a nicety.
- **`sessions.js` gravity.** Navigator wiring touches it only through `registerEphemeralSession`, which already exists for exactly this shape.
