> Historical document, superseded. This was the implementation-planning doc drafted before the GitHub PR Auto-Review feature was built. Current behavior: see AGENTS.md's "GitHub PR Auto-Review" section.

# Code Change Plan: GitHub PR Auto-Review

**Status:** pending approval
**Mode:** direct plan (decisions locked with the user)
**Source:** the finalized build plan (artifact `ab3a965c`) + three Explore passes over `server/`, `session/`, `teamlib/`, `notifications/`
**Feature:** an opt-in poller that reviews the user's own open PRs, resolves conflicts, and merges the clean ones on green checks, pinging Telegram on anything actionable. Default off; all config keys absent = current Glissa, unchanged.

---

## 1. Requirements Summary

Add an optional background lane to Glissa's existing Windows backend that, every 15 minutes:

1. Lists open PRs on repos the user explicitly opted in (`config.prReview.projects`).
2. Filters to the user's own non-draft branches (skip forks, drafts, bots).
3. For each PR with a new head SHA since last review, spawns one ephemeral headless (`claude -p`) review session:
   - **Clean lane** (no conflict): runs in the repo dir, diff-only, no working-tree mutation, coexists with a live interactive session in the same repo.
   - **Conflict lane** (`mergeable == CONFLICTING`): runs in a throwaway git worktree, resolves conflicts, pushes the resolution to the PR branch.
   - Posts a `gh pr comment` when changes are needed; writes a machine-readable verdict to a result file.
4. Carries per-PR state across ticks and, on a later tick, merges (`gh pr merge --rebase`) any reviewed-clean/resolved PR once GitHub checks are green and it touches no `.github/workflows/` files.
5. Pushes a Telegram message on actionable transitions only (changes requested, conflicts resolved, merged, error).

The Telegram piece is PR-only: a direct push helper the poller calls, **not** a `NotificationManager` channel (so no focus-suppression interaction, no session-complete pings).

### Non-goals

- No de-Windowing, no Linux/cloud host, no change to detection/state-machine/teams/notifications.
- No running of the repo's tests locally (correctness gated by GitHub checks).
- No auto-merge of fork PRs, draft PRs, bot PRs, or PRs editing `.github/workflows/`.
- No surviving-a-closed-laptop work (that is `powercfg` + `nssm`, out of band).

---

## 2. Locked Decisions

| Decision | Choice |
| --- | --- |
| Watch scope | Explicit opt-in list of Glissa project ids (`config.prReview.projects`) |
| Auto-merge gate | Clean review **and** green checks **and** no `.github/workflows/` edits |
| After conflict resolution | Merge once checks pass (treated like any clean PR) |
| Which PRs | User's own branches, non-draft; skip forks and bots |
| Poll interval | 15 minutes (`config.prReview.intervalMinutes`, default 15) |
| Merge method | Rebase (`gh pr merge --rebase`) |
| Review depth | Read-only (diff-only); no local test run |
| Telegram pings | Actionable only: changes / resolved / merged / error |

---

## 3. Architecture

### 3.1 Altitude: one seeded session, not the Teams runtime

`orchestrator.runTeam` (`teamlib/team-orchestrator.js:203`) needs a registered `projectId`, an authored+validated `team.json`, and a pack-setup gate before any spawn, and its merge-back is a local `git merge --ff-only` (`teamlib/team-git.js:219`), not a GitHub merge. Wrong shape. Instead, mirror the ephemeral headless session factory `makeStageSession` (`server/backend.js:501-534`): `new Session({ path, extraClaudeArgs: ['-p'], initialPrompt, dangerouslySkipPermissions, settingsPermissions, ephemeral: true, hookRouter, getHookPort })`, spawn through the shared `spawnGate` (`server/backend.js:458`), and key completion on the `exit` event (exit 0 = the `-p` run finished, the pattern at `teamlib/team-orchestrator.js:187`).

### 3.2 Two lanes

- **Clean lane** — session cwd is the project path (`getProjectPathById(projectId)`, used at `server/backend.js:546,621`). The agent only runs `gh pr diff`/`gh pr view`/`gh pr comment` (remote) and reads files at HEAD. `effectiveCwd()` returns `this.path` when no worktree is injected (`session/sessions.js:900-902`), so nothing dirties the tree. It coexists with a live interactive session in the same repo (two PTY processes, each its own injected settings file).
- **Conflict lane** — the poller calls `gitWorkspace.create({ projectPath, teamId: 'pr-review', label: 'pr-<N>', worktreeBase })` (`teamlib/team-git.js:115-193`) to fork an isolated worktree (branch `glissa/pr-review/pr-<N>`, namespaced away from the `glissa/session/*` boot sweep at `team-git.js:454`). The session runs in that worktree; the agent runs `gh pr checkout <N>`, `git rebase origin/<base>`, resolves, commits, `git push`. On session exit the poller calls `gitWorkspace.discard({ projectPath, workspace })` (`team-git.js:383-394`) to tear the worktree down. team-git's internal `serialize()` queue (`team-git.js:76`) means these ops never race a concurrent team run.

### 3.3 Verdict contract (result file, not reviewDecision)

**GitHub blocks approving/requesting-changes on your own PR**, so the verdict cannot ride `gh pr review`. The agent writes a result file (JSON) to a path the poller passes in the prompt; the poller reads it after `exit`. This mirrors the codebase's file-based handoff convention (teams gate on handoff files, never stdout scraping).

Result shape:
```json
{ "verdict": "CLEAN | CHANGES | RESOLVED | ERROR", "head": "<sha>", "summary": "<one line>" }
```
- `CLEAN` — no conflict, no changes needed → poller phase `awaiting-checks`.
- `RESOLVED` — was conflicting, resolved + pushed, otherwise clean → phase `awaiting-checks` (fresh head from the push).
- `CHANGES` — needs changes (agent already posted a `gh pr comment`), or touches `.github/workflows/` → phase `done`.
- `ERROR` — session could not complete / could not confidently resolve → ping error, phase `error`.

The agent never runs `gh pr merge`. The poller merges on a later tick when phase is `awaiting-checks` and `gh pr checks <N>` is all-green.

### 3.4 Per-PR state machine (in the poller)

```
new / new-head-SHA ──spawn review──▶ (agent runs)
   ├─ CHANGES  ──▶ done            (comment posted; ping "changes")
   ├─ CLEAN    ──▶ awaiting-checks (silent)
   ├─ RESOLVED ──▶ awaiting-checks (ping "resolved")
   └─ ERROR    ──▶ error           (ping "error")

awaiting-checks ──checks green──▶ merged  (gh pr merge --rebase; ping "merged")
awaiting-checks ──checks failing──▶ error (ping "error", once)
done / merged / error ──new commit (head changes)──▶ new  (re-review reopens it)
```

### 3.5 Module layout (pure core + IO shell, mirroring `session/core/*`)

- **`server/core/pr-review-core.js`** — pure, no IO, no `require` of Session/backend. Unit-testable like `session/core/*` and `server/scheduler.js` (which injects `now`/timers).
  - `filterActionablePrs(prs, opts)` — drop drafts, forks (head repo ≠ base repo), bots (author is a Bot / dependabot / renovate).
  - `planReviews(prs, state)` — PRs whose `headRefOid !== state[key].reviewedHead` and not in-flight → review actions.
  - `planMerges(prs, state)` — PRs in phase `awaiting-checks` → merge candidates (shell then queries checks).
  - `nextState(prevPhase, verdict, newHead)` — verdict → phase transition.
  - `pingFor(transition)` — actionable-only message string or `null`.
  - `prKey(project, pr)` — stable `owner/repo#N` key.
- **`server/pr-poller.js`** — IO shell. `createPrPoller(deps)` returns `{ start, stop }`. All IO injected for testability:
  - `listPrs(projectPath)` → wraps `gh pr list --json number,headRefOid,mergeable,isDraft,headRepositoryOwner,author,files`.
  - `spawnReview({ projectPath, pr, resultPath, worktreeCwd })` → builds the ephemeral `-p` Session (via a new `makeReviewSession`, §4.4), `spawnGate.run(() => sess.start())`, resolves on `exit` with the parsed result file.
  - `gitWorkspace` (the shared instance), `readChecks(projectPath, n)` (`gh pr checks`), `mergePr(projectPath, n, method)` (`gh pr merge --rebase`), `telegram` (§4.2), `readState`/`writeState` (§4.5), `now`, `setIntervalFn`/`clearIntervalFn`.
  - A re-entrancy guard (`tickRunning`) so a slow tick never stacks; a `maxConcurrentReviews` cap (default 3) on in-flight sessions.
- **`server/pr-telegram.js`** — `sendPrPing(botToken, chatId, text)`, one fire-and-forget HTTPS POST, never throws.
- **`server/backend.js`** — boot wiring (§4.6): construct + `start()` the poller when `config.prReview.enabled`; `stop()` in `shutdown()`; add `makeReviewSession`.

---

## 4. Implementation Steps

Phased so each phase is independently verifiable. No source is edited until this plan is approved.

### Phase 0 — Config + Telegram helper (pure, no behavior change)

**Files:** `server/pr-telegram.js` (new), `config.json` (doc only — keys stay absent by default).

1. `server/pr-telegram.js`: export `sendPrPing(botToken, chatId, text)`. Use `node:https` (or the existing HTTP client convention — confirm none is mandated; `https.request` to `https://api.telegram.org/bot<token>/sendMessage` with `{ chat_id, text }`). Fire-and-forget: attach `.on('error', ...)` → `console.warn('[pr-telegram] ...')`, never throw. No ret\-loop.
2. Config is read raw (`server/config-store.js:129` loads the whole JSON verbatim), so `config.prReview` and `config.telegram` are readable directly with no schema change — the `osToast` precedent (`server/backend.js:400`). Keys stay out of `DEFAULT_CONFIG` so absence = disabled. (If a Settings-UI toggle is ever wanted, add to `BOOLEAN_KEYS` + `getSettings()`; out of scope now.)

Config shapes (documented, user adds by hand to enable):
```json
"telegram": { "botToken": "...", "chatId": "..." },
"prReview": {
  "enabled": false,
  "intervalMinutes": 15,
  "mergeMethod": "rebase",
  "maxConcurrentReviews": 3,
  "reviewTimeoutSeconds": 900,
  "projects": ["<glissa-project-id>"]
}
```

**AC-0:** `sendPrPing` unit test with an injected fake POST verifies URL, body, and that a network error is swallowed (no throw). Config with keys absent → `config.prReview` is `undefined` → poller never constructed.

### Phase 1 — Poller pure core + skeleton (dry-run, no spawns)

**Files:** `server/core/pr-review-core.js` (new), `server/pr-poller.js` (new).

1. Implement `pr-review-core.js` pure functions (§3.5). Fork detection: `pr.headRepositoryOwner.login !== <base repo owner>` OR compare `headRepositoryOwner` to the repo derived from the project. Bot detection: `pr.author.__typename === 'Bot'` or login in `['dependabot[bot]','renovate[bot]']` (confirm the `gh` JSON field names against installed `gh`).
2. `pr-poller.js`: `createPrPoller(deps)`. `start()` arms `setIntervalFn(tick, intervalMinutes*60000).unref()` (the `healthInterval` precedent, `server/backend.js:363-384`) and runs one immediate tick. `tick()`: guard `tickRunning`; for each opted-in projectId resolve path, `listPrs`, `filterActionablePrs`, `planReviews`/`planMerges`. In this phase, **log intended actions only** (`log`-style), spawn nothing.
3. `stop()` calls `clearIntervalFn`.

**AC-1 (pure, the bulk of testing):**
- `filterActionablePrs` drops draft/fork/bot, keeps own non-draft. (table-driven)
- `planReviews` selects only PRs with a changed head vs `state.reviewedHead`; skips in-flight.
- `nextState` maps each verdict to the right phase; `pingFor` returns a message only for actionable transitions and `null` for `CLEAN→awaiting-checks`.
- `createPrPoller` with fake timers + fake `listPrs`: a tick lists, filters, and plans without spawning; `stop()` clears the timer. (mirrors `server/scheduler.js` injected-timer tests)

### Phase 2 — Clean lane (spawn review, result file, comment, ping)

**Files:** `server/backend.js` (add `makeReviewSession`), `server/pr-poller.js` (wire `spawnReview`).

1. `makeReviewSession({ id, name, path, initialPrompt, permissions })` — copy the `makeStageSession` body (`server/backend.js:501-534`) but register in a new `reviewSessions` Map (not `teamSessions`, to keep team code paths clean) with the same auto-remove-on-exit + `destroy` wrapper. Options: `extraClaudeArgs: ['-p']`, `dangerouslySkipPermissions: true`, `settingsPermissions: PR_REVIEW_DENY`, `ephemeral: true`, `hookRouter`, `getHookPort`, `replayBufferKB: config.replayBufferKB`. Not carded (headless, no watchable TUI — same rationale as `backend.js:519-521`).
2. `PR_REVIEW_DENY` — a `{ deny: [...] }` fragment (`settings-injector.js:66` accepts `{ deny: [<rule strings>] }`, merged only when non-empty; verified). Each entry must be valid Claude Code permission-rule syntax, **not** a free-form glob — e.g. `Bash(gh pr merge:*)`, `Bash(gh pr close:*)`, `Bash(gh repo delete:*)`, `Bash(git push --force:*)`, `Bash(git push -f:*)`, `Edit(.github/workflows/**)`, `Write(.github/workflows/**)`. Pin the exact strings during build against the installed Claude Code. Best-effort only (it runs under `--dangerously-skip-permissions`, per R3) — a belt, not the belt.
3. **[timeout — critic finding #1]** `spawnReview` builds the review prompt (§4.3) with the PR number, base branch, and `resultPath` (a temp file under `os.tmpdir()`, **not** the repo, to keep the clean lane collision-free). `spawnGate.run(() => sess.start())`. Arm a hard timeout mirroring `runStage` (`teamlib/team-orchestrator.js:184`: `setTimeout(() => { session.destroy(); resolve('timeout') }, reviewTimeoutSeconds*1000)`, timer `.unref()`'d, cleared on `exit`). On `exit`, read+parse `resultPath`, delete it, resolve the verdict (`ERROR` if missing/unparseable). On timeout: `session.destroy()`, resolve `ERROR`, clear the in-flight lock, ping error. Without this a hung `-p` session pins the PR in-flight forever and, once `maxConcurrentReviews` such sessions accumulate, silently disables the whole feature.
4. Poller applies the verdict: `CHANGES` → `pingFor` → `sendPrPing`, state `done`; `CLEAN` → state `awaiting-checks` (silent). **[re-review termination — critic finding #5]** Record `reviewedHead` by a **mandatory** poller-side re-query `gh pr view <N> --json headRefOid` after exit — never trust the agent's self-reported `head` (it may capture the pre-push SHA and cause an endless re-review + duplicate comment/ping loop). Add a short settle+retry (e.g. 2–3 reads over a few seconds) so GitHub's eventual-consistency window right after a resolve-push can't record a stale head. The in-flight lock stays set until `reviewedHead` is recorded.
5. **[atomic state — critic gap]** Every write of the state file uses tmp-file + rename (the codebase convention at `server/config-store.js:161-163`) so a crash mid-write can't leave a torn `.glissa/pr-review-state.json`.

**AC-2:** With a fake `spawnReview` returning each verdict, the poller: records the correct `reviewedHead` (from the re-query, not the agent), sets the right phase, and pings exactly on `CHANGES` (not `CLEAN`). A `spawnReview` that never resolves is force-resolved to `ERROR` by the timeout and frees its in-flight slot (no permanent cap starvation). Integration smoke (manual, one real repo): a clean PR gets `verdict CLEAN`, no comment, no merge, moves to `awaiting-checks`; repo working tree stays clean (`git status` unchanged) throughout.

### Phase 3 — Conflict lane (worktree, resolve, push)

**Files:** `server/pr-poller.js`.

1. **[branch-in-use precheck — critic finding #3]** When `pr.mergeable === 'CONFLICTING'`, first check whether the PR's head branch is already checked out in any worktree (`git worktree list --porcelain` → compare head ref names). These are the user's OWN branches, so it is normal for the operator to be working on the very branch the PR is from; git forbids the same branch in two worktrees, so `gh pr checkout <N>` would fail with "already checked out". If it is checked out anywhere, degrade to `ERROR` + ping ("branch checked out locally, resolve manually") — do **not** spawn a doomed session.
2. Otherwise `gitWorkspace.create({ projectPath, teamId: 'pr-review', label: 'pr-'+n, worktreeBase: getWorktreeBase(projectPath) })`. If `isGit === false` (non-git / `reason`), fall back to `ERROR` + ping (cannot isolate). Otherwise spawn the review session with cwd = `workspace.cwd`.
3. The prompt's conflict branch (§4.3) instructs `gh pr checkout <N>`, `git rebase origin/<base>`, resolve, commit, `git push`; if not confidently resolvable, write `ERROR` and do not push. (Confirm whether `gh pr checkout --detach` is available on the installed `gh` — a detached checkout avoids creating the persistent local branch that finding #6 must otherwise clean up.)
4. On `exit`, `gitWorkspace.discard({ projectPath, workspace })` regardless of verdict (teardown is junction-safe, `team-git.js:386-393`). **[branch leak — critic finding #6]** `discard` deletes only `workspace.branch` (`glissa/pr-review/pr-N`); `gh pr checkout <N>` created a *separate* local branch (the PR head ref) that `discard` does not remove. After `discard`, best-effort `git branch -D <prHeadRef>` in `projectPath` (or use `--detach` per step 3) so no persistent branch accumulates per review. `RESOLVED` → ping "resolved", state `awaiting-checks`; `ERROR` → ping error.
5. Boot orphan cleanup: on `start()`, best-effort prune stale `glissa/pr-review/*` worktrees **and** any leaked PR-head local branches (list via `git worktree list --porcelain` / `git branch`, `discard`/`removeWorktreeByPath` any with no matching in-flight PR). The `glissa/session/*` boot sweep (`team-git.js:484-492`) does **not** cover this namespace, so the poller owns it.

**AC-3:** Fake `gitWorkspace` (inject `git` runner) verifies: `create` is called for a CONFLICTING PR only after the branch-in-use precheck passes; a PR whose head branch is checked out elsewhere yields `ERROR` + ping and never calls `create`; `discard` is called on every exit path; the leaked PR-head branch is deleted after `discard`; a non-git project yields `ERROR` not a crash. Manual: a deliberately-conflicted PR on a scratch repo is resolved, pushed (new head SHA), pinged "resolved", the worktree is gone (`git worktree list` clean), and **no persistent branch or worktree remains** in the main repo.

### Phase 4 — Merge on green

**Files:** `server/pr-poller.js`.

1. **[no-checks edge — critic finding #4]** `readChecks(projectPath, n)` must return a four-way status `{ green, failing, pending, none }`, not a boolean. `gh pr checks <N>` exits non-zero (code 8) on a PR with **no** checks — that is `none`, NOT green. Merging on `none` would push a resolved conflict to the default branch with **zero CI verification**, nullifying the entire R1/R2 safety argument (which rests on "the fresh CI run catches a wrong-side pick"). So: `none` is **non-mergeable** — ping once and leave it for the human. Merge only on `green`.
2. Each tick, for PRs in phase `awaiting-checks`, over the **filtered** PR list (a PR that flipped to draft mid-flight must not merge — critic non-blocking): `readChecks`. `green` → re-verify the PR touches no `.github/workflows/` (defense in depth) → `mergePr(projectPath, n, 'rebase')` → ping "merged", state `merged`. `failing` or `none` → ping "error" once (dedupe via a `pingedError` flag in state), leave for the human. `pending` → wait for the next tick.
3. **[external merge/close — critic non-blocking]** `gh pr list` returns only OPEN PRs. A PR merged/closed outside Glissa between ticks simply drops out of the list: treat its disappearance as a silent terminal transition and **prune its state entry** (prevents unbounded state-file growth). A `mergePr` call that fails because the PR was already merged/closed is a silent no-op, not an "error" ping.
4. A new head SHA on a `done`/`merged`/`error` PR (re-push, new commit) → `planReviews` reopens it as `new` (re-review). `planMerges` consumes the `filterActionablePrs` output so draft/fork/bot flips are excluded from merging.

**AC-4:** Fake `readChecks`/`mergePr`: `green` → merge called once + ping "merged"; `failing` → ping "error" once (not repeated across ticks); `none` → no merge, ping "error" once (the safety-critical case); `pending` → no merge. A PR that touches `.github/workflows/` never reaches merge. A PR that vanishes from the list is pruned from state with no spurious ping; a `mergePr` failing on an already-merged PR does not ping "error".

### Phase 5 — Boot wiring + shutdown

**Files:** `server/backend.js`.

1. After `spawnGate`/`gitWorkspace`/`sessions` exist and near the existing timer/scheduler wiring (`healthInterval` at `backend.js:363-384`, `armTeamSchedules` at `:669`), construct the poller **only** when `config.prReview?.enabled`:
   ```js
   let prPoller = null;
   if (config.prReview?.enabled && config.telegram?.botToken) {
     prPoller = createPrPoller({ config, spawnGate, gitWorkspace, getProjectPathById,
       makeReviewSession, telegram: (text) => sendPrPing(config.telegram.botToken, config.telegram.chatId, text),
       /* listPrs, readChecks, mergePr via child-process-safe gh calls */ });
     prPoller.start();
   }
   ```
2. **[shutdown teardown — critic finding #2]** In `shutdown()` (`backend.js:1289-1313`), beside `clearInterval(healthInterval)` and the team-scheduler `disarm()` loop, call `prPoller?.stop()`. Critically, `shutdown()` today destroys + reaps only the `sessions` and `teamSessions` maps (`backend.js:1302-1309`); the new `reviewSessions` map is invisible to it, so an in-flight review PTY (worst case: a conflict-lane session mid-`git push`) would be orphaned. Iterate `reviewSessions` alongside `teamSessions` — `sess.destroy()` and push each `_killReap` into the bounded reap that `server.js` awaits. `prPoller.stop()` also destroys in-flight review sessions.
3. **[auth probe — critic non-blocking, adopt]** On `start()`, run a one-time `gh auth status`; on failure, log an actionable startup warning (converts an otherwise-silent every-tick no-op into a visible signal). A `gh` failure mid-tick (e.g. `listPrs` ok but `readChecks` rate-limited) leaves that PR's state unchanged and retries next tick — no partial-state mutation.
4. All `gh`/`git` invocations go through `server/child-process-safe.js` (the only module allowed to import `node:child_process`, per CLAUDE.md) with `windowsHide`.

**AC-5:** With `config.prReview.enabled` absent/false → `prPoller` is `null`, no timer armed, zero behavior change (existing backend tests still pass). With it true but `telegram` absent → poller does not start (pings would be undeliverable); log a one-line warning. `shutdown()` clears the interval **and** destroys/reaps in-flight `reviewSessions` (no orphaned PTY, no dangling handle keeps the event loop alive).

---

## 4.x Supporting Details

### 4.2 Telegram helper contract
`sendPrPing(botToken, chatId, text)` → single HTTPS POST, resolves void, never throws. Message text examples: `"Glissa PR: changes requested on owner/repo#12 — <summary>"`, `"merged owner/repo#12 (rebase)"`, `"conflicts resolved on owner/repo#12, awaiting checks"`, `"error on owner/repo#12 — <reason>"`.

### 4.3 Review prompt (the `initialPrompt`)
Passed per PR. Key instructions (exact wording refined during build):
- You are an automated reviewer for a repo the operator owns. Review PR #`<N>` (base `<base>`).
- Do **not** run `gh pr merge` (a separate process merges after checks pass). Do **not** use `gh pr review` (self-review is blocked on own PRs); post findings with `gh pr comment`.
- Step 1: `gh pr view <N> --json mergeable,mergeStateStatus,files`.
- Step 2: if any file is under `.github/workflows/` → comment that a human must merge workflow changes, write verdict `CHANGES`, stop.
- Step 3: if `mergeable == CONFLICTING` → you are in an isolated worktree: `gh pr checkout <N>`, `git rebase origin/<base>`, resolve every conflict faithfully to both sides' intent, commit, `git push`. If not confidently resolvable, write `ERROR` with the reason and stop — never push a guess.
- Step 4: review `gh pr diff <N>` against repo conventions (read `CLAUDE.md`/`AGENTS.md`). Needs changes → `gh pr comment <N>` with specifics, verdict `CHANGES`. Resolved+clean → `RESOLVED`. Clean, no conflict → `CLEAN`.
- Step 5: write `{ "verdict", "head", "summary" }` to `<resultPath>`.
- Constraints: never force-push, never delete branches/repo, never touch other PRs, never edit `.github/workflows/`.

### 4.4 Why a new `reviewSessions` map (not reuse `teamSessions`)
`makeStageSession` registers into `teamSessions`, which team shutdown/config-reload logic iterates. Mixing PR sessions there risks surprising that logic. A parallel `reviewSessions` Map with the identical auto-remove pattern keeps the lanes independent for ~30 lines. (Reuse the *pattern*, not the map.)

### 4.5 State file
`.glissa/pr-review-state.json` (per project root, or one global under `~/.glissa/`; pick per-project to match the `.glissa/` convention). Shape: `{ "owner/repo#N": { reviewedHead, phase, wasConflicting, pingedError } }`. Written after each transition via **tmp-file + rename** (the `config-store.js:161-163` convention) so a crash mid-write cannot leave a torn file. Out of `config.json` so it never churns settings. Load on `start()`; tolerate a missing/corrupt file (start empty). Entries for PRs no longer in `gh pr list` are pruned each tick (§Phase-4.3) to bound growth.

---

## 5. Risks and Mitigations

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Auto-merge is outward-facing and irreversible-ish | Gate hard: own non-fork branches only, non-draft, non-bot, never `.github/workflows/`, never without **green** checks. Post-resolution merge waits for the **fresh** CI run — the exact check that catches a wrong-side conflict pick. **A repo with no required checks (`readChecks == none`) is never auto-merged** (§Phase-4.1) — otherwise this whole safety argument silently evaporates on a CI-less repo. |
| R2 | Agent resolves a conflict wrong and pushes a bad merge | Prompt forbids guessing (write `ERROR` instead); the pushed resolution still must pass CI before merge; it is a normal commit the operator can revert. |
| R3 | `-p` session with skip-permissions runs arbitrary `gh`/`git` | Deny-list fragment (§Phase-2.2) blocks force-push/delete/merge/workflow edits; own repos on localhost; document as best-effort. |
| R4 | Slow tick (long conflict resolution) stacks with the next tick | `tickRunning` re-entrancy guard + `maxConcurrentReviews` cap; `spawnGate` serializes spawn starts (ConPTY wedge, `spawn-gate.js`). |
| R5 | Resolve-push changes head → PR re-reviewed forever | Record `reviewedHead` = post-exit head; in-flight lock stops overlapping ticks double-grabbing; phase `awaiting-checks` is not re-reviewed unless head changes again by an external push. |
| R6 | Orphaned `glissa/pr-review/*` worktree after a crash | Boot prune of that namespace in `start()` (the `glissa/session/*` sweep does not cover it). |
| R7 | `gh` not authenticated / not on PATH on the host | Prereq documented; a failing `gh pr list` logs and the tick no-ops (no crash); consider a one-time `gh auth status` check at `start()`. |
| R8 | GitHub `gh` JSON field names differ across `gh` versions | Confirm `headRefOid`, `mergeable`, `isDraft`, `headRepositoryOwner`, `author`, `statusCheckRollup` against the installed `gh` before finalizing the field list. |
| R9 | Live config reload won't refresh `prReview`/`telegram` (unlisted keys, `applySettings` `config-store.js:195-214`) | Documented "read once at boot, restart to change" (same as `osToast`). Acceptable; note in the Settings docs. |
| R10 | A hung `-p` review session pins a PR in-flight forever; `maxConcurrentReviews` fills and the feature silently self-disables | Hard per-session timeout mirroring `runStage` (`team-orchestrator.js:184`) → `destroy()` + `ERROR` + free the slot (§Phase-2.3). |
| R11 | In-flight review PTY orphaned on server restart (new `reviewSessions` map invisible to `shutdown()`) | `shutdown()` iterates `reviewSessions` and awaits their `_killReap` (§Phase-5.2). |
| R12 | Conflict lane fails when the operator has the PR's own branch checked out in the main worktree | Branch-in-use precheck degrades to `ERROR` + ping before spawning (§Phase-3.1). |
| R13 | `gh pr checkout` leaks a persistent local branch that `discard` doesn't remove | `git branch -D <prHeadRef>` after `discard`, or `gh pr checkout --detach` (§Phase-3.4); boot prune of leaked branches (§Phase-3.5). |
| R14 | Resolve-push re-review loop / duplicate outward comments from a stale agent-reported head | Mandatory poller-side `gh pr view --json headRefOid` re-query with settle/retry; never trust the agent's `head` (§Phase-2.4). |

---

## 6. Verification Steps

1. **Unit (pure core):** run the `pr-review-core.js` suite — filter, planReviews, planMerges, nextState, pingFor (AC-1, AC-2, AC-4 logic). Highest coverage lives here by design.
2. **Unit (shell with fakes):** `createPrPoller` with injected timers + fake `listPrs`/`spawnReview`/`gitWorkspace`/`readChecks`/`mergePr`/`telegram` — verify tick planning, verdict application, merge-on-green, error-ping dedupe, worktree create/discard pairing, `stop()` teardown.
3. **Unit:** `sendPrPing` swallows network errors (AC-0).
4. **Regression:** existing backend/session/team suites pass with `prReview` absent (AC-5) — proves zero change to current behavior.
5. **Manual integration (scratch repo, `prReview.enabled` on):**
   - Clean PR → verdict `CLEAN`, no comment, `awaiting-checks`, then merged on green; repo tree stays clean throughout (clean-lane collision-free property).
   - PR needing changes → `gh pr comment` posted, Telegram "changes", never merged.
   - Conflicted PR → resolved, pushed, worktree torn down, Telegram "resolved", merged after fresh CI green.
   - PR touching `.github/workflows/` → `CHANGES`, never merged.
   - Draft / fork / bot PR → ignored.
6. **Concurrency:** open 3+ eligible PRs at once → sessions serialize on spawn, cap respected, no ConPTY wedge, all processed across ticks.

---

## 7. Open Items to Confirm During Build (not blockers)

1. `gh` JSON field names + `statusCheckRollup` shape on the installed `gh` (R8).
2. Whether an existing HTTP client helper should back `sendPrPing` vs raw `node:https`.
3. State file location: per-project `.glissa/pr-review-state.json` vs one global `~/.glissa/`.
4. Exact `PR_REVIEW_DENY` glob list that `settingsPermissions` accepts (confirm the deny-fragment schema the settings injector honors).
5. `getWorktreeBase` reuse for the conflict lane vs team-git's `os.tmpdir()` default (recognizable path vs pure throwaway).

---

## 8. Acceptance Criteria Rollup (testable)

- [ ] Feature is inert with `config.prReview` absent/`enabled:false` (existing suites green).
- [ ] `filterActionablePrs` excludes draft, fork, and bot PRs (unit).
- [ ] A PR is reviewed exactly once per head SHA (dedupe via a poller-re-queried `reviewedHead` + in-flight lock); a resolve-push does not trigger re-review.
- [ ] Clean lane performs no working-tree mutation (`git status` unchanged before/after) and no `git checkout`.
- [ ] Conflict lane: branch-in-use precheck blocks a doomed checkout; creates and always discards an isolated worktree; deletes the leaked PR-head branch; a non-git project degrades to `ERROR` without crashing; **no persistent branch or worktree remains**.
- [ ] A hung review session is force-resolved to `ERROR` by the timeout and frees its in-flight slot (no cap starvation).
- [ ] The agent never calls `gh pr merge`; merge happens only from the poller, only when checks are `green` (never `none`/`failing`/`pending`) and no `.github/workflows/` file is touched.
- [ ] Telegram fires only on changes / resolved / merged / error; silent on `CLEAN→awaiting-checks`; error ping is not repeated across ticks; no ping for an externally-merged PR.
- [ ] State file is written atomically (tmp+rename) and pruned of PRs no longer open.
- [ ] `shutdown()` clears the poll interval, destroys/reaps in-flight `reviewSessions`, and the process exits cleanly.

---

## 9. Changelog — Critic Round 1 (applied)

Critic verdict **REVISE**; all ~15 file:line citations verified correct; the self-approval finding (§3.3) and clean-lane collision-free claim (§3.2) both held up. Applied fixes:

- **#1 CRITICAL** — added a hard review-session timeout (§Phase-2.3, R10, `reviewTimeoutSeconds` config).
- **#2 MAJOR** — `shutdown()` now tears down the `reviewSessions` map (§Phase-5.2, R11, AC-5).
- **#3 MAJOR** — branch-in-use precheck before the conflict lane (§Phase-3.1, R12, AC-3).
- **#4 MAJOR** — `readChecks` four-way `{green,failing,pending,none}`; `none` is non-mergeable (§Phase-4.1, R1, AC-4).
- **#5 MAJOR** — mandatory poller-side head re-query with settle/retry (§Phase-2.4, R14).
- **#6 MAJOR** — delete the leaked `gh pr checkout` local branch after `discard`; corrected AC-3 wording (§Phase-3.4/3.5, R13).
- **Non-blocking** — external merge/close handling + state pruning (§Phase-4.3), `planMerges` on filtered list (§Phase-4.4), pinned deny-list rule syntax (§Phase-2.2), `gh auth status` startup probe (§Phase-5.3), atomic state write (§4.5).

Remaining build-time confirmations (unchanged from §7, plus critic's): `gh pr checks` exit-code semantics for {none,pending,failing}; `gh pr checkout --detach` availability; `gh pr view --json headRefOid` eventual-consistency window.

---

*Plan pending approval, critic round 1 applied. On approval, suggested execution order = Phase 0 → 1 → 2 → 3 → 4 → 5, each phase verified before the next.*
