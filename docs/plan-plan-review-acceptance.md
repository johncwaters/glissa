# Plan Review acceptance: prove the feature against a real Claude Code

Draft plan (2026-09-08) for testing the Plan Review feature that `docs/plan-plan-review.md` designed and commits `bb3a37d`, `9cee100` and `83bcbf3` shipped. Every proposal here is either a script with an exit code or a `node:test` file; the record itself only names them and the reasoning behind their scope.

## Why

The shipped feature carries 193 automated tests across thirteen files, and every hook, hold, release path, cap, wire arm, watcher and frontend core named in the design record is pinned by one of them. What none of them does is drive a real `claude` binary: every backend plan test constructs the lane in process and posts payloads the test itself composed. The only evidence that Claude Code 2.1.263 accepts the settings Glimmervoid writes, calls the held URL, honours the 86400 second timeout, obeys the composed replies and writes an edited plan back to disk is the spike harness of 2026-09-07, which ran outside Glimmervoid against a stand-in hook server and asserted nothing. That harness lives in a scratchpad directory and will be gone with the session.

Two consequences. First, the integration between the injector, the hold and the real binary has never been exercised as one path, so a wrong matcher string or a settings-validation warning would pass the suite and fail the first operator. Second, every Claude Code upgrade can move the payload shape, the dialog behaviour or the timeout semantics, and today nothing notices before an operator does. The acceptance run has to be a command that can be rerun after each upgrade, not a memory of a spike.

The dashboard surfaces have a separate gap: the frontend tests run against hand-rolled DOM fakes under `node:test`, no browser has ever rendered the plan face, and the repo has no browser driver (`assets/AGENTS.md` records that the README gif was captured with Playwright kept outside the repo). The only browser on this machine is Firefox.

## What is already pinned

- Pure cores: `tests/plan-review-core.test.ts` (18), `tests/plan-feedback-core.test.ts` (7), `tests/frontend-plan-markdown.test.ts` (14), `tests/frontend-plan-view.test.ts` (16), `tests/frontend-plan-diff.test.ts` (11), `tests/frontend-plan-link.test.ts` (1).
- Backend: `tests/backend-plan-hook.test.ts` (15, real `createBackend` over a loopback server), `tests/backend-plan-hold.test.ts` (17, every release path and both caps, manual timers), `tests/backend-plan-draft.test.ts` (14), `tests/backend-plan-notify.test.ts` (6).
- Wire: `tests/contracts-plan-review.test.ts` (16), `tests/control-plan-review.test.ts` (25), the replay fixture `tests/fixtures/v2-waiting-plan.jsonl` through `tests/replay-harness.test.ts`.
- Frontend face: `tests/frontend-plan-face.test.ts` (33) with a stub modal.

Unpinned:

- The lane's own prune timer: `pruneAgedFiles` is tested generically in `tests/prune-files.test.ts`, but nothing references the plan suffix or the 30 day retention, and the timer in `server/plan-review-wiring.ts` is never driven.
- `public/plan/plan-feedback-dialog.ts` has no test; the face tests inject a stub in its place.
- `tests/dom-selector-contract.test.ts` carries no plan selectors, although M1 of the design record listed it.
- The v2 replay fixture is synthetic (`/home/u/...`); no test parses bytes a real Claude Code emitted, for either hook event.

## Design

### The live harness

`test/probe-plan-review.ts`, run by hand with `node`, billed, sibling of `test/probe-codex-session.ts` and `test/ablation/run-pairs.ts` and built on `test/support/backend-harness.ts` (`listen`, `findFreeHighPort`, `connectControl`, `makeClaudeConfig`, `awaitBackendShutdown`, `removeHarnessTempDirectory`). Nothing new is added to `package.json`.

Per scenario it boots the real backend in process on a throwaway `GLIMMERVOID_CONFIG` (so the revision store lands beside that config and never in `~/.glimmervoid/plans`), a throwaway Claude config directory with the scenario's project directory pre-trusted, and a scratch git repository as the session's path, and it sets `process.env.CLAUDE_CONFIG_DIR` to that throwaway config before creating the backend, because `claudePlansRoot` in `server/plan-review-wiring.ts` derives the draft containment root from the BACKEND process env and not from the session's spawn env, so without it the draft watch and the draft read refuse the real plan file and scenario 3 never sees a draft. It adds a session over the control socket, sets the initial prompt in process the way `run-pairs.ts` does, wraps `_ptySpawn` to append `--model sonnet --permission-mode plan` to the arguments the registry already built, so the base scenarios keep the registry's default `--dangerously-skip-permissions` and the injector's settings argument untouched, and starts the session. Plan mode is forced by the flag, not asked of the model, because in plan mode the only way forward is `ExitPlanMode`; the prompt is the spike's (a plan file with a title, exactly three numbered steps and a fixed CHALLENGE line, then call `ExitPlanMode`), which produced a permission request in nine of nine spike runs.

The harness observes through the same surfaces a dashboard would, never through the lane's internals: the control socket for `session-plan-changed`, `session-plan-draft`, `session-plan-response` and `session-error`, the session snapshot for status and prompt kind, the data socket at `/terminals/:id` for terminal bytes and for the two scenarios that write to it (5 answers the dialog, 7 sends `/plan` and then the task prompt), and the plan file on disk. Each assertion failure ends the run non-zero with the scenario name and the assertion; a passing run prints one line per scenario. Every scenario also writes a result file (`--out <dir>`), shaped like the spike's: the `claude --version` string, the settings file the injector wrote, every control frame received, the raw hook request bodies as the route saw them, the stripped terminal tail and the plan file contents after.

A hold that nothing releases would leave a billed session waiting a day, so the harness carries its own deadline per scenario (180 seconds), and on expiry sends `terminal`, exits the session with the spike's escalation (Escape, `/exit`, Ctrl-C twice, SIGTERM, SIGKILL) and reports the timeout as a failure.

### Scenarios and what each proves

Every scenario begins with the same capture assertions: the session snapshot reaches state `WAITING` with `pendingPromptKind` `plan`; a `session-plan-changed` frame arrives with `state: open`, `revision: 1`, `hasPlan: true` and a non-empty title; `session-plan` returns a body whose `plan` bytes equal the plan file on disk and whose `planFilePath` sits under the throwaway Claude config's `plans` directory; the terminal shows no settings warning.

1. Approve. `plan-decision` with `approve` on revision 1. Asserts: a `session-plan-changed` frame with `state: decided` then one with `state: closed` and `approvedRevision: 1` (the second only arrives if the real `PostToolUse` hook fired, which is the whole point); the terminal shows "Allowed by PermissionRequest hook"; the session leaves plan mode and finishes its turn; after the session exits, `session-plan` still returns the body (operator decision 5, read from disk); the throwaway `plans` directory holds exactly one `.jsonl`.
2. Approve with an edited plan. Same as 1 with `plan` set to the received plan plus a marker line before CHALLENGE. Asserts, on top of 1: the plan file on disk contains the marker after the close, which only Claude Code can have written since M3 removed Glimmervoid's rewrite path; the transcript's `ExitPlanMode` result carries `planWasEdited: true`.
3. Revise, then approve. `revise` with whole-plan feedback and two section comments, one addressed to a heading and one general. Asserts: the terminal shows the composed message text; at least one `session-plan-draft` frame arrives while Claude Code rewrites the file, and `session-plan` with `draft: true` during that window returns revision 0 with the current file bytes (this is the draft chip end to end, and it is the one place the watcher meets a real editor); a second `session-plan-changed` with `revision: 2`, `state: open`; the revision 2 body differs from revision 1 and contains a phrase from the feedback; `renderPlanDiff`'s core produces a non-empty diff between the two bodies; then `approve` on revision 2 closes with `approvedRevision: 2`.
4. Approve and accept edits. `approve-accept-edits` on revision 1. Asserts 1 plus the terminal's mode indicator reading accept edits after the close, matching spike experiment K.
5. Answer in terminal. `terminal` on revision 1 (the lane writes `{}`), then the harness answers the dialog through the data socket with the keystrokes spike 4 used: once the terminal tail carries "Would you like to proceed?" and the stream has gone quiet, it writes Escape `[B` then carriage return, taking the second option. If the tail never carries that text, or the write leaves the dialog open, the scenario fails printing the dialog text it saw, so a moved or renamed option reads as a harness update and not as a Plan Review defect. Asserts: a `session-plan-changed` with `state: released`; then `closed` with `approvedRevision: 1` (the real `PostToolUse` on a released review recording the terminal approval); the terminal shows "User approved Claude's plan" without the hook line.
6. Session exit during the hold. No decision; the harness stops the session over the control socket while the review is open. Asserts: `state: released`, the hook socket closed without a reply written after it (the harness logs the route's response lifecycle), the session exits within the harness's shutdown budget, and the backend shuts down with no held reply left (the shutdown flush path, observed live).
7. Plan mode without the flag. Scenario 1's flow again, but the `_ptySpawn` wrap appends only `--model sonnet`, the session is added with no initial prompt set, since the initial prompt becomes the spawn's final positional argument and would dispatch the task turn before any `/plan` could be written, and the harness reaches plan mode the way an operator does: it sends `/plan` as its own turn over the data socket, waits for the terminal's plan-mode indicator, and only then submits the spike's task prompt over that same socket as bracketed paste, the `\x1b[200~`/`\x1b[201~` framing `pasteText` in `session/session-output.ts` writes, followed by a submitting carriage return, the newline-safe equivalent of the positional argument scenarios 1 to 6 hand the spawn, since a raw write of a multi-line prompt dispatches its first line as a turn and every line after it as another. The two turns are not one because `/plan` is a local command with an argument hint, so a prompt prefixed to it can be swallowed as that argument and never dispatched; if the indicator never appears the scenario fails naming the mode the terminal showed, so a harness miss reads as a harness update and not as a Plan Review defect. Only this scenario proves that a session which reaches plan mode the way a Glimmervoid-spawned session does, without the flag, still produces the `PermissionRequest` hook call. Asserts: every scenario's capture assertions; scenario 1's close; and equal `git status --porcelain` output captured when the hold opens and before the decision, so edits during a bypass plan hold are a defect rather than a surprise.

Scenarios 1 to 5 and 7 each cost one sonnet plan turn plus, for 3, one revision; 6 costs a partial turn. The whole run is around ten minutes and well under a dollar at list price.

### Real bytes as fixtures

The harness's `--record-fixtures` flag writes the raw `permissionrequest-plan` and `posttooluse-plan` bodies from scenario 1 into `tests/fixtures/claude-2.1.263-plan-request.json` and `tests/fixtures/claude-2.1.263-plan-result.json` with the plan text replaced by a short constant and the paths rewritten under `/home/u`. `tests/contracts-plan-review.test.ts` gains one test per fixture that parses those bytes through the real schemas, and `tests/backend-plan-hold.test.ts` gains one that posts the recorded result body and sees the review close. When a later Claude Code moves a field, the harness rerun rewrites the fixtures and the suite says exactly which parser broke; the version in the filename says which binary the bytes came from.

### The dashboard walkthrough

No browser driver exists in the repo, and the root `AGENTS.md` rule "Do NOT add dependencies without explicit instruction" makes adding one the operator's call, asked as decision 4 below. Firefox ships WebDriver BiDi over a plain WebSocket (`firefox --remote-debugging-port`), which Node 22's built-in client can speak with no dependency, but a BiDi driver is a project of its own and the face is already pinned at the DOM-fake level. The walkthrough is therefore run by hand once, and its result is recorded in the Verification section below as one dated line per surface. The desktop leg runs in Firefox against scenario 3 of the harness, held at the revision 1 hold by a `--pause-at open` flag and reached over loopback, because the harness binds 127.0.0.1 only and never widens for a walkthrough: a wider bind is the unauthenticated socket `server/main.ts` warns about, offered here into a live session carrying a copy of the real credentials. The phone leg therefore runs against the operator's normal Glimmervoid instance, which already carries remote mode and its pairing, with a plan-mode session started by hand. It checks, in order: the card flips to the plan face and the Board shows "Plan ready"; the Focus center shows the whole plan with constant button labels; "Comment" on a heading, "Send feedback" with the composed text visible; the draft chip appears while the agent rewrites; "Diff" shows revision 2 against 1 with collapsed context; "Edit plan" then "Approve" echoes the edit; the `#plan/<id>` link reopens the same review after a reload; the phone Terminal screen reaches the plan through its own entry and back; a browser notification arrives with the plan title. A failed check is a defect to fix and re-walk, not a note.

### Closing the unit gaps

Three small `tests/` additions, all pure or driven through existing seams: the lane's prune timer with the plan suffix and retention through manual timers, a `plan-feedback-dialog` test through the same fake DOM the face tests use, and the plan face's selectors added to `tests/dom-selector-contract.test.ts` as M1 promised.

## Not planned

- A browser automation dependency, or a Firefox BiDi driver, unless the operator answers decision 4 the other way.
- Running the harness under `npm test`: it is billed and needs credentials, so it stays in `test/` with the other probes, per `test/AGENTS.md`.
- Re-measuring the 86400 second timeout or the timeout-fired abandonment: spike experiments L and N settled them, and a rerun costs an hour of wall clock per assertion.
- Driving `AskUserQuestion`: its own plan, as the design record decided.

## Decisions

Asked of the operator before the build:

1. Model for the billed scenarios: sonnet (the spike's choice, cheapest that reliably calls `ExitPlanMode`), or the operator's default model to match real use.
2. Whether the walkthrough result goes into this record's Verification section (proposed) or is only kept in the harness result directory.
3. Whether scenario 6 (session exit during the hold) is worth its partial turn, given the unit test already pins every release path. Proposed: keep it, since it is the one path where a real socket and a real process are torn down together.
4. Whether a browser driver may be added for the walkthrough, which the dependency rule reserves for the operator. Proposed: no, hand-walk it once, with Firefox WebDriver BiDi over Node's built-in WebSocket client as the no-dependency alternative if a repeatable browser check is wanted later.

## Milestones

M1, harness and fixtures: `test/probe-plan-review.ts` with scenarios 1 to 7, `--out`, `--pause-at`, `--record-fixtures`, the two recorded fixtures and their three tests, a row in `test/AGENTS.md`. One passing run recorded here.

M2, walkthrough and unit gaps: the dashboard walkthrough on desktop and phone with its dated lines below, then the three `tests/` additions.

## Verification

Filled in when each run passes: date, `claude --version`, the command, one line per scenario or surface.

## Risks

- The model declines to call `ExitPlanMode` or writes a malformed plan: the spike's prompt plus `--permission-mode plan` produced nine of nine requests, and scenario 7 runs that same prompt after a `/plan` turn instead, a route the spike never measured; the harness nudges with a bare return up to three times as the spike did, then fails the scenario rather than retrying the turn.
- Nested Claude Code environment: the harness runs from inside an agent session, and `session/core/spawn-env.ts` scrubs the parent's Claude variables the way the spike did by hand; scenario 1 asserts the session reached plan mode, which fails first if the scrub is incomplete.
- Scenario 5 drives the approval dialog with keystrokes, which the design record put under "Not planned" for the product: a hand-run harness pinned to one recorded `claude --version` can carry a rebindable key where a shipped feature cannot, and its failure names the dialog text.
- Claude Code upgrades between runs: the result file and the fixture filenames carry the version, so a diff between runs names the binary.
- Credentials: the throwaway Claude config carries a copy of the real credentials, and the harness reuses `removeHarnessTempDirectory`, which exits non-zero if that copy survives.
