# Plan: Navigator (real-time AI pair navigator)

Status: planning, drafted 2026-08-20. Nothing here is built. When implementation lands, `AGENTS.md` and the code win over this doc, and superseded sections move to `docs/archive/` per convention.

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
- **M3 tab.** Navigator tab renders findings and the intent doc; `VIEW_TABS` entry; control-WS broadcasts with a deliberate replay-retention decision. Tests: broadcast shape, retention rule.
- **M4 model dispatch.** The ephemeral navigator lane produces a tier 3 comment end to end on a fixture buffer, and the Usage tab shows the `navigator` lane row. Tests: dispatch gate (budget, debounce), result-file parsing, lane ledger entry.
- **M5 intent model.** A correction round-trips from the tab into the next dispatch. Tests: intent-core merge rules.

Doc gate: the checkable claims in this plan are the milestone tests named above. As milestones land, their sections graduate into `AGENTS.md` and this doc heads to `docs/archive/`.

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
