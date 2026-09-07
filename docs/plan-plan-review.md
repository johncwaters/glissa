# Plan: Plan Review

Status: Draft plan (2026-09-07). Four hook behaviors stay unverified until the spike that opens M2 (see "Spikes").

## Why

When an agent in plan mode calls `ExitPlanMode`, the whole plan is printed into the terminal and a three-option dialog follows. Plans on this machine run 6 to 17 KB (`~/.glissa/recordings/` holds three `ExitPlanMode` requests of 6271, 8454 and 12317 chars; the trace lane recorded one of 16933). In an xterm pane that text has already scrolled and redrawn by the time the dialog appears, and on the phone layout the operator reads it through a full-bleed terminal with a key strip. Feedback goes through the dialog's single text field, one line, no reference to the section being discussed. The result is that plans get approved on a skim, or the operator walks to a desktop.

Glissa already receives the complete plan and throws it away:

- `PermissionRequest` is registered unmatched for every Claude Code session (`detection/settings-injector.ts:77`, `:124-129`), so the `ExitPlanMode` request arrives over `POST /hook/:glissaId/permissionrequest` with `tool_input.plan` (markdown) and `tool_input.planFilePath`. `HookRouter.handle` maps it to the `awaiting-input` signal and `pendingPromptKind: 'permission'` (`detection/hook-source.ts:91`, `session/adapters/claude-code.ts:65-74`) and returns `{ ok: true }` at once (`server/backend-http.ts:165-207`). Nothing reads `tool_input`.
- No `PostToolUse` matcher covers `ExitPlanMode` (`detection/settings-injector.ts:79-80`), so the approved plan is never seen either.
- The state machine has no plan concept (`shared/states.ts`, `session/core/state-machine.ts:23-70`); the card shows "Needs Input" for a permission prompt and for a plan alike.
- The dashboard has no markdown renderer and no per-session URL; the trace panel renders bodies as `<pre>` (`public/trace-panel.ts:230-240`), and hash routing exists for Settings only (`public/app.ts:489-492`, `:477`).

## Sources compared

Verified 2026-09-07 against the hooks, permission-modes and sessions docs and against `claude` 2.1.263 on this machine.

| Source | Plan text | Sends a decision back | Cost | Stable |
|---|---|---|---|---|
| `PermissionRequest` hook, matcher `ExitPlanMode` | `tool_input.plan`, `tool_input.planFilePath` | yes: `decision.behavior` allow or deny, `decision.message` shown to Claude on deny, `updatedInput`, `updatedPermissions` | already registered; one HTTP round trip that Claude waits on | documented |
| `PreToolUse` hook, matcher `ExitPlanMode` | same fields | yes: `permissionDecision`, `permissionDecisionReason` (shown to Claude on deny), `updatedInput`; allow for this tool requires `updatedInput` | new registration; `PreToolUse` is off outside the PostHog lane by design | documented |
| `PostToolUse` hook, matcher `ExitPlanMode` | `tool_response.plan`, `filePath`, `isAgent`, `hasTaskTool` (observed) | no, the plan is already approved | one matcher entry beside the wakeup matcher | documented (`plan`, `filePath`) |
| Plan file on disk | `~/.claude/plans/<slug>.md`, or `plansDirectory` under the project | no | `fs.watch` on one path once `planFilePath` is known | undocumented filename scheme; the path arrives in the hook |
| Transcript JSONL | `tool_use` input, already in `~/.glissa/traces/<id>.jsonl` when the trace lane is on (`server/core/trace-core.ts:180`) | no | zero inside the agent | format declared internal, trace lane is `debugMode` only |
| PTY keystrokes into the dialog | none | yes, fragile | none | option list varies (`showClearContextOnPlanAccept` adds a first option, the first label changes with auto mode and bypass availability), every key rebindable |

The hook is the only source that both carries the plan and takes a decision, and it is the one Glissa already holds.

## Spikes

Run 2026-09-07 with `claude` 2.1.263, an HTTP hook server, and node-pty.

- Confirmed: `claude -p` has `ExitPlanMode` disabled outright ("ExitPlanMode is disabled for this session"), so the documented `defer` round trip is not a route for Glissa's interactive sessions.
- Confirmed: while the `PermissionRequest` hook response is held (25 s in the spike), the terminal shows no approval dialog. When the hook answers `{}` (no decision), the dialog appears: "Claude has written up a plan and is ready to execute. Would you like to proceed? 1. Yes, and use auto mode 2. Yes, manually approve edits 3. Tell Claude what to change". This is the mechanism: Glissa holds the request while the operator reviews on any device, and an empty answer hands the decision back to the terminal unchanged.
- Confirmed: an approval fires `PostToolUse` for `ExitPlanMode` with `tool_response` keys `plan`, `isAgent`, `filePath`, `hasTaskTool`, and `tool_response.plan` equals the displayed plan byte for byte.
- Confirmed: text typed into the terminal during a hold is queued as a normal message ("Press up to edit queued messages"), not lost.
- Confirmed (spike 2, interactive): a bare `decision.behavior: "allow"` on `PermissionRequest` does not approve `ExitPlanMode`; the native dialog appears anyway. Approval has to carry `updatedInput`, matching the documented rule for this tool.
- Unverified, and the first task of M2: whether an allow carrying `updatedInput` that echoes the plan bypasses the dialog; whether an edited `updatedInput.plan` is what the model receives as the approved plan and whether it lands in the plan file; whether rewriting the plan file before the allow changes what the model receives; the exact tool result the model sees after `behavior: "deny"` with a `message`, and whether it stays in plan mode and resubmits; whether `updatedPermissions` `setMode: acceptEdits` reproduces the "auto-accept edits" option. The interactive runs for these died with the test harness on a loaded machine, not with Claude Code. Each is a documented behavior, so the design assumes the documented outcome and M2 begins by confirming it.

## What already exists

Reuse, do not rebuild:

- Hook registration per event with a per-entry `timeout` (`detection/settings-injector.ts:124-129`, default 5 s at `:13`); matcher-scoped entries for `PostToolUse` (`:130-136`). The `ExitPlanMode` request needs its own `PermissionRequest` entry pointing at a second URL, `<hook base>/permissionrequest-plan`, with a long timeout, plus its own `PostToolUse` matcher. The plan endpoint is a second URL, not a second handler on the same URL: a matcher-scoped entry does not shadow the unmatched one, Claude Code runs every matching hook in parallel, and a `PermissionRequest` payload carries no tool-use id, so two entries on one URL would arrive as two indistinguishable posts and the lane could store two revisions and hold two replies. The unmatched `PermissionRequest` entry is left exactly as it is and keeps answering at once for every tool, `ExitPlanMode` included, so the status signal path is unchanged and only the plan endpoint holds and stores.
- The hook seam: `HookRouter.handle` (`detection/hook-source.ts:61-103`) returns synchronously and `server/backend-http.ts:186-206` builds the reply, already returning `hookSpecificOutput.additionalContext` for pack notices. `HookRouter.handle` stays synchronous: the plan endpoint's express handler, once `handle` has returned 200, asks the plan-review lane's held-reply registry (keyed by glissaId plus agentId, one open entry per agent) for a promise and awaits it before writing the response, so every other event keeps the synchronous reply path untouched.
- The pending prompt channel: `pendingPromptKind` is set from the `awaiting-input` signal (`session/sessions.ts:527`), emitted as `prompt-kind-change`, carried by `session-prompt` (`shared/contracts/control-messages.ts:278`) and the snapshot (`shared/contracts/session.ts:26`). A `'plan'` value fits without a new message.
- Per-session request and reply over the control WS, body only on explicit request over an authenticated socket: `session-trace` and `session-trace-response` (`shared/contracts/control-messages.ts:124-128`, `:341-348`; handler `server/control-handlers.ts:1030-1042`).
- Per-session artifact storage keyed by UUID under a config sibling directory (`server/trace-wiring.ts:222`, `configSiblingPath`), `appendJsonLine` in `server/json-file.ts`, age retention in `session/session-recorder.ts:185`.
- Views: a primary view is a `<section id="view-*">` in `public/index.html:183-192` and an entry in `VIEW_TABS` (`public/app.ts:582-592`); a phone screen is a nested entry in `public/phone/phone-shell.ts:39-49` that re-parents the desktop panel through `adoptElement`. Chrome from `public/dom-helpers.ts`, confirms from `public/session-card/modal.ts`, persistent UI state through the `PREFS` table in `public/ui-prefs.ts`.
- Card actions: the overflow menu (`public/session-card/card-dom.ts:103-108`) and the phone Terminal screen top bar (`public/phone/terminal-screen.ts`).
- Deep links: `public/settings-link.ts` builds `#settings/<section>`; a `#plan/<sessionId>` route touches three sites, the resolver `activateSettingsHash` (`public/app.ts:489-492`), the `hashchange` listener (`:749`) and the cold-boot resolution (`:689`). A notification tap from a closed dashboard is the cold-boot path at `:689`.
- Notification copy lives in `notifications/`, delivered as `notify` (`shared/contracts/control-messages.ts:350-355`).
- The trust rule: `ws.glissaTrust` per socket (`server/backend-websockets.ts:109`); terminal input from a paired phone is already accepted over the data WS, so a plan decision from the same socket is the same trust level.

## Design

### The decision flow

1. Claude calls `ExitPlanMode`. The `PermissionRequest` hook posts the payload. The existing route in `server/backend-http.ts` only forwards the event, the glissaId, the payload and a reply promise slot to an injected plan-review dependency, `planReview.onHookEvent`, exactly as it already forwards pack notices; the `ExitPlanModeInput` parse, the revision store and the held-reply registry live in `server/plan-review-wiring.ts` on `server/core/plan-review-core.ts`. The lane parses `tool_input` through a Zod schema `ExitPlanModeInput` (`plan: string`, `planFilePath: string`, plus the optional `agent_id` and `agent_type` common input fields read from the payload) and fails closed: an unparseable body is handled exactly as today (reply at once, terminal dialog appears).
2. The plan-review lane appends a revision `{ sessionId, revision, plan, planFilePath, receivedAt, agentId: string | null, agentType: string | null }`, both agent fields written at receive time from the hook payload because the store is append-only and nothing can be filled in later, to `~/.glissa/plans/<sessionId>.jsonl` and keeps the open review in memory. The session is already `WAITING`; `pendingPromptKind` becomes `'plan'` (adapter: `mapHookPromptKind` returns `'plan'` when `tool_name === 'ExitPlanMode'`). A `session-plan-changed` push carries `{ id, agentId, revision, state, chars, title }` only, never the body.
3. The HTTP reply is held, and only when a control WebSocket client, the dashboard or a paired phone, is connected now or was connected within the last 90 seconds. With no client inside that window the plan endpoint answers `{}` at once and the review is recorded as released, so an operator who lives in the terminal sees no change at all. A control socket drops on screen lock and on any network blip and reconnects with backoff (`public/control-ws.ts:138`), which is the phone case this plan is for, so a disconnect never ends a hold by itself: a reconnecting client counts as connected and the hold survives a disconnect for a reconnect grace of 90 seconds, a constant rather than a setting. The one constant serves both gates, so a plan arriving a minute after a phone screen lock is held for the same grace as one whose hold started before the lock, instead of being released before the notification lands. The hook entry's `timeout` is set well above the hold; Glissa's own cap `planReview.holdSeconds` (default 1800, 0 disables holding) ends the hold with `{}`, which shows the terminal dialog. A hold also ends with `{}` when the operator chooses to answer in the terminal, when the reconnect grace expires with no control client back, when the session exits, and when the server shuts down (the pending replies are flushed before the listener closes; a crash means Claude sees a connection failure, which is documented as non-blocking and also falls through to the dialog). Fail open in every path. Each review carries its own `state` of `open`, `released`, `decided` or `closed`, pushed to every surface through that review's `session-plan-changed` summary, and each action bar renders from its own review's `state` alone. Releasing the hold for any reason moves that review to `released`, so its action bar turns read-only and shows "Answer in the terminal" as status text while any other review of the same session stays actionable.
4. The operator opens the plan on desktop or phone, reads it whole, and sends one `plan-decision` client message `{ id, agentId, revision, decision, feedback?, plan? }`:
   - `approve`: reply `decision.behavior: "allow"` with `updatedInput: { plan, planFilePath }` echoing the plan (a bare allow leaves the dialog up, spike 2; the echo is also the edit channel).
   - `approve-accept-edits`: the same plus `updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }]`, the hook form of "Yes, auto-accept edits" (unverified, M2 spike).
   - `revise`: reply `decision.behavior: "deny"` with `message` set to the composed feedback. Claude stays in plan mode, revises, and calls `ExitPlanMode` again, which arrives as revision n+1 and reopens the review with a diff against revision n.
   - `terminal`: reply `{}`.
   The moment the held HTTP reply is written, or its connection aborts, the review leaves `open`: it moves to `decided` after an allow or a deny and to `released` after a pass-through or an abort, and no later decision is accepted. A decision naming a revision other than the open one is refused with `session-error`, so a phone that lagged behind a resubmission cannot approve the wrong text. A decision on a released revision, or on any revision whose review is no longer open, is refused the same way.
5. `PostToolUse` for `ExitPlanMode` arriving on a `decided` review records the approved text from `tool_response.plan`, whichever surface approved it, and moves that review to `closed`, freeing its in-memory entry. The next `PermissionRequest` on a `decided` review, the normal sequel to a deny, opens the next revision on that same review. Neither is guaranteed to follow a decision: Claude Code re-evaluates configured ask and deny rules after an allow, and the operator can interrupt the pending tool call, so a review left in `decided` with neither arriving is closed on a turn-end hook, a subagent's review on the `SubagentStop` whose `agent_id` matches it and the main agent's review on `Stop`, both already registered (`detection/settings-injector.ts:77`). A terminal "Tell Claude what to change" produces no `PostToolUse`; the next `PermissionRequest` is simply the next revision. A released review closes on the same signals, whichever of `PostToolUse` or the next revision arrives first. `SessionEnd` and process exit close an open review as abandoned.

Hooks fired inside a subagent carry `agent_id` and `agent_type` among the common input fields, so `ExitPlanModeInput` reads both from the payload and the revision record stores `agentId` and `agentType` at receive time. The held-reply registry is keyed by glissaId plus agentId, null for the main agent, so concurrent subagent plans hold, release and close independently, and the view labels a revision carrying an agentId as that agent's plan. A headless child cannot reach this path at all, because `claude -p` has `ExitPlanMode` disabled (spike 1). An in-process subagent that did call it is held like the parent's plan, bounded by the hold cap and by the connected-client gate.

### Feedback in tandem

The reply on `revise` is the "No, keep planning" channel, so feedback quality is the whole product here. The view renders the plan by section (every heading opens one) and lets the operator attach a comment to a section or to the whole plan. A pure `server/core/plan-feedback-core.ts` composes the deny message: a header naming the revision, then one block per commented section quoting its heading and the comment, then general comments. The agent gets structured, addressed feedback instead of one line, and the next revision can be diffed against the one the comments referred to.

Editing the plan directly is the second channel, the hook form of the terminal's Ctrl+G. The view offers an editor over the markdown (a textarea; phone keyboards handle it); approving from the editor sends the edited text as `plan`, which the server places in `updatedInput.plan`. Whether the file at `planFilePath` also has to be rewritten so the disk copy matches what the model received is what the M2 spike answers; the server does whichever the spike shows is needed, behind a containment check that the path sits under `~/.claude/plans` or the project's `plansDirectory`.

Between a `revise` and the next submission the agent rewrites the plan file (observed in the trace: two `Write` calls to the same `~/.claude/plans/<slug>.md` in one planning turn). Once `planFilePath` is known from revision 1, the lane watches that one file with `fs.watch` and pushes a `session-plan-draft` notice; the view shows a "draft updated" chip and can render the in-progress draft read-only. Before the first submission there is no supported signal and none is invented.

### Surfaces

Desktop: a primary view "Plan" beside Trace, one session at a time, opened from the card (the "Needs Input" badge reads "Plan ready" when `pendingPromptKind` is `'plan'` and clicking it opens the view) and from the tab. Layout: a reading column of at most 72ch, a heading rail on the left that scrolls the column, revision picker and a diff toggle in the section head, a sticky action bar at the bottom with the decisions. A session lists one review per agent, the main agent's and one per subagent that called `ExitPlanMode`, labeled by `agentType`, each with its own revision picker and its own action bar, and a decision acts only on the review it sits under. Rendering goes through a pure `public/plan-markdown-core.ts` producing a block tree (ATX headings, paragraphs, ordered and unordered lists with indent nesting, fenced code, tables, blockquotes, rules, inline code, emphasis, links), turned into DOM with `el()` and `textContent` only; no HTML from the plan is ever parsed. `plan-markdown-core` accepts only `http:` and `https:` for an `href` and renders every other link as plain text, so it never emits a `javascript:` or a `data:` URL into the dashboard origin, and external links open with `rel="noopener noreferrer"`. `tests/frontend-plan-markdown.test.ts` pins this with a `javascript:` case and a `data:` case. No dependency is added.

Phone: a nested `plan` screen in the phone shell that adopts the same panel. Reached from a Board row (attention state "Plan ready" joins the existing "needs you" ordering, with no new rule), from the Terminal screen top bar, and from a notification tap through the deep link `#plan/<sessionId>`. The action bar is thumb-reachable at the bottom; section comments open in a sheet; the editor is the same textarea full-bleed. The key strip is not involved.

Buttons carry constant labels: "Approve", "Approve and accept edits", "Send feedback", "Answer in terminal", "Edit plan". Progress and revision counts live in status text beside them.

Notification: the existing `WAITING` notification gains plan copy ("Plan ready for review: <title>") when the kind is `'plan'`, and its click target is the deep link.

### Contracts and storage

| Piece | Where | Role |
|---|---|---|
| `plan-review-wiring.ts` | `server/` | The lane: the `ExitPlanModeInput` parse, the revision store, the held-reply registry, the `planReview.onHookEvent` dependency the existing hook route calls, control handlers wiring |
| `plan-review-core.ts` | `server/core/` | Pure: revision numbering, open, released and closed state transitions, decision validation, reply composition for allow, deny and pass-through |
| `plan-feedback-core.ts` | `server/core/` | Pure: composes the deny message from section comments |
| `plan-review.ts` | `shared/contracts/` | Payload schemas |
| `plan-panel.ts`, `plan-view-core.ts` | `public/` | DOM shell and pure view core |
| `plan-markdown-core.ts` | `public/` | Pure block-tree renderer input |
| `plan-diff-core.ts` | `public/` | Pure: line diff between two revision bodies the view already holds, matching `public/sidebar/diff-core.ts` |
| The plan screen | `public/phone/` | No new module; the phone screen adopts the panel |
| Invariants | `server/AGENTS.md` plus one row in the root `AGENTS.md` Invariants table | Hold is fail-open, body only on request over an authenticated socket, hook response may carry operator text from an authenticated control socket |

- `shared/contracts/plan-review.ts` holds only `ExitPlanModeInput`, `PlanRevision`, `PlanReview` (`agentId: string | null`, `agentType: string | null`, `revisions`, `state`, `openRevision: { revision, since } | null`, `approvedRevision: revision | null`) and `PlanReviewState` (`reviews: PlanReview[]`), one review per agent, because the held-reply registry is already per agent and a per-session shape would collapse two concurrent subagent plans into one summary and one action bar. The wire arms live in `shared/contracts/control-messages.ts` with their `CLIENT_MESSAGE_TYPES` and `SERVER_MESSAGE_TYPES` entries, as the trace arms do (`docs/plan-session-trace.md:56`): client `session-plan` (request body) and `plan-decision`, both carrying `agentId` beside the session `id`; server `session-plan-changed` (summary push, body-free, one review per push) and `session-plan-response` (body on request). `session-plan-changed` is registered in `REFRESHABLE_TYPES` at `server/core/control-send-core.ts:11`, so it is dropped rather than queued under backpressure. Types from `z.infer`.
- Storage: `~/.glissa/plans/<sessionId>.jsonl`, one revision per line, age retention shared with traces. The approved plan stays readable after the session ends.
- Config: `planReview: { enabled: true, holdSeconds: 1800 }` in `shared/contracts/config.ts`, a settings row in the machine level. The default holds for 30 minutes but only behind the connected-client gate of step 3, so an operator who never opens the dashboard sees the terminal dialog exactly when it appears today. The 90 second reconnect grace of step 3 is a constant in `server/core/plan-review-core.ts`, not a setting.
- Hook settings: a `PermissionRequest` entry `{ matcher: 'ExitPlanMode', url: <hook base>/permissionrequest-plan, timeout: holdSeconds + 60 }` beside the unmatched entry, which is left exactly as it is; the event segment of the existing `POST /hook/:glissaId/:event` route is free-form today, so `permissionrequest-plan` needs no new route and the route itself gains one injected dependency and no new URL handling. `ExitPlanMode` is added to the `PostToolUse` matcher list. The hook route's body cap rises for this route only, from 64 KB to 512 KB, because a dropped body today destroys the request silently.

### Not planned

- Keystroke driving of the approval dialog (unstable option list, rebindable keys).
- Plan text from the transcript (unsupported format; the trace lane covers debugging).
- A markdown or diff dependency.
- A live view before the first submission (no supported signal; `FileChanged` hooks watch literal filenames in the working directory only).
- `AskUserQuestion` through the same hold: eight such requests sit in the recordings with the same payload shape, and the seam built here fits them, but that is its own plan.

## Open questions

Three cuts have been proposed across the review rounds and the operator decides each one.

- The plan-file `fs.watch` and the draft chip. Keep them because the operator sees the agent revising in response to the feedback just sent, which is the tandem feel this plan is for. Cut them because the same text arrives complete as the next revision through the hook, so the watch buys only latency and a second render path.
- The `approve-accept-edits` decision and its `updatedPermissions` `setMode` payload. Keep it because the phone otherwise cannot reach the auto-accept mode without the terminal. Cut it because "Answer in terminal" already exposes the native option and the hook behavior is unverified.
- The revision diff (`public/plan-diff-core.ts`, the diff toggle, "with a diff against revision n"). Keep it because addressed feedback is checked against what actually changed. Cut it because the revision picker already opens revision n and M1 ships without it.

The operator's answers move each item into or out of M3 before that slice starts.

## Milestones

M1, capture and read: `ExitPlanModeInput` schema, `pendingPromptKind: 'plan'`, revision store, the `session-plan-changed` summary and the `session-plan` body request, the Plan view on desktop and phone with the markdown core, "Plan ready" on the card and Board, the deep link, notification copy. No hold: the terminal dialog still decides, the view is read-only. Tests: contracts, `frontend-plan-markdown`, `frontend-plan-view`, a replay fixture for the plan request, `dom-selector-contract`, `settings-injector-user-hooks` for the new entries.

M2, decide: the spike above first, then the plan hook endpoint and its held reply with the cap, the connected-client gate with its reconnect grace and every fail-open path, the `state` field with its `open`, `released`, `decided` and `closed` values, `plan-decision` guarded on the open revision, `approve`, `revise` with whole-plan feedback, `terminal`, `PostToolUse` closing. `server/AGENTS.md` sits at the byte cap of `tests/agents-md-size.test.ts`, so this slice retires one rule already pinned by a test before adding the Plan Review section, per the repo's cap rule, and names the retired rule in its commit. Tests: `backend-hook-route` for the hold and each release path, plus a configured ask or deny rule after an allow and an interruption during the hold, a subagent review closed on `SubagentStop` and the main review on `Stop`, `control-plan-review` for the decisions and for two concurrent subagent reviews in one session where deciding one leaves the other actionable.

M3, tandem: section comments and the composed feedback, the editor with `updatedInput.plan` and the file rewrite if the M2 spike requires it, `approve-accept-edits`, the plan-file watch and draft chip, the revision diff (`public/plan-diff-core.ts`) and its toggle. Tests: `plan-feedback-core`, `plan-diff-core`, watch wiring, path containment.

## Risks

- Claude Code changes `tool_input` field names: the schema fails closed and the request behaves as today.
- A hold outlives the hook `timeout`: the timeout is derived from `holdSeconds` at settings build time, and the cap fires first.
- Hook timeout semantics change: the terminal dialog is always the fallback, never a stuck session.
- An operator approves in the terminal while the phone shows the review: `PostToolUse` closes the review on both.
- A plan over the body cap: the cap is raised for this route and a rejected body is logged with its size instead of destroyed silently.
- A client connects and then idles: the terminal dialog stays down until the cap fires. The released state and the constant-label "Answer in terminal" action are the mitigation, and the gate keeps an operator who never opens a client out of this case entirely.
