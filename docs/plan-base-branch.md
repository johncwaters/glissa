# Plan: configurable base branch, no hardcoded `develop`

Status: design for review, drafted 2026-08-30, revised the same day twice (glissa-wide config,
commit skill trunk-only; then remote-as-truth and develop left alone). Nothing implemented. Two
repos are touched: this one (Part A) and `claude-setup` `skills/commit` + profiles (Part B).
`AGENTS.md` and the code win over this doc once work lands.

## Problem

Glissa and the `/commit` skill both assume a gitflow shape: feature -> `develop` -> `main`. The
target is the PostHog shape: branch off the repo's default branch, land on it, nothing in between,
unfinished work behind flags rather than on a long-lived branch.

- Glissa's `integrationBranch` (`server/config-store.js:80`) defaults to `'develop'`, and five call
  sites bypass the config with a literal `'develop'` fallback. The review sidebar's copy says
  "Merge into develop" whatever the real target is.
- `/commit` promotion hardcodes `develop` as the intermediate hop (`land.ts` `promotionHops`), and
  when it is absent it **creates** it (`createDevelop`). The preflight remedy `switch-to-develop`
  moves a commit made on `main` onto `develop`.

## Decisions taken in review

1. Glissa config stays **machine-wide**: one `integrationBranch` for every project, no per-project
   override.
2. `/commit` is a personal tool and adopts the trunk flow outright. No gitflow mode is preserved.
3. **Worktrees stay.** Every Glissa session still runs in its own worktree forked off the base
   branch and merged back by rebase-then-fast-forward. Trunk-based changes only *which* branch that
   is, never the isolation. (`AGENTS.md` "Development Workflow" already states this as a convention
   for fanning out over this repo; unchanged.)
4. **Remote is the source of truth for the base branch.** Local `main` is a cache of `origin/main`:
   it is fast-forwarded from origin before anything forks from it or lands on it, and after a
   landing the result is pushed. A local `main` that has diverged from origin is never rebased,
   reset, or force-pushed by any tool; it is surfaced and blocks until a human resolves it. Applies
   to both Part A and Part B.
5. **`develop` branches are not deleted**, locally or on origin. Once 1-4 land nothing reads them.
   They are ordinary branches from then on, left to drift.

Out of scope: PR-shaped session close-out, spawn-from-issue, prompt levers for feature flags.

---

## Part A: Glissa

### A1. Config semantics

`integrationBranch` keeps its place in `DEFAULT_CONFIG` and `settings-map.mjs`; its meaning becomes:

| Value | Meaning |
|---|---|
| a branch name | every project forks from and merges back into that branch |
| `null` | **auto**: per repo, `origin/HEAD` target, else `main`, else `master`; if none, the existing `no-base-branch` path applies unchanged |

`origin/HEAD` is checked first because of decision 4: the remote decides what the default branch is.

`DEFAULT_CONFIG.integrationBranch` changes from `'develop'` to `null`. Migration: every existing
`config.json` was seeded with the explicit `'develop'` string, so installed machines keep their
behavior byte-for-byte until the operator edits the key; fresh installs get auto. Concretely:

- `shared/contracts/config.js`: the key accepts `string | null`.
- `config-store.js` `applySettings`: `''` and `null` normalize to `null` (today the value is coerced
  to string, `tests/config-store.test.js:287`, which would turn an emptied field into `''`).
- `settings-map.mjs:119`: description becomes "Base branch for session worktrees. Empty = each
  repo's default branch." Still read-only / file-only in this pass.

Alternative rejected: keep `'develop'` as the default and require explicit opt-out. That leaves one
hardcode standing and makes a fresh clone of a trunk repo silently fork from a branch that does not
exist there (`ensureLocalBranch` would create `develop` from `main`, the same failure `/commit` has
today).

### A2. One resolver

Pure, in `server/core/integration-branch-core.js`:

```js
// The ONLY place the configured base branch is read. Returns the name, or null meaning auto.
configuredIntegrationBranch(config) -> string | null
```

IO, in `server/git-workspace.js`:

```js
detectDefaultBranch(projectPath) -> string | null   // origin/HEAD -> main -> master -> null
```

`createBody` already takes `baseBranch`; when it is `null` it calls `detectDefaultBranch` and writes
the result into the existing per-branch marker (`branch.<name>.glissa-integration`,
`git-workspace.js:242`). The marker stays the authority for a live worktree, so changing the config
never retargets a running session (unchanged invariant, `git-workspace.js:553`).

### A3. Remote as source of truth (new)

Today the base-vs-origin relationship is *reported* (branch-sync indicator,
`server/core/branch-sync-core.js`) and *resynced on demand* (`resync-branch`,
`control-handlers.js:983`, which fast-forwards `behind`, pushes `ahead`, and refuses `diverged`).
Decision 4 makes the fast-forward part automatic at the two moments that matter, reusing the same
classification and the same two ff mechanisms (`ff-merge` when the base is the main checkout's HEAD,
`ff-fetch <remote> <branch>:<branch>` otherwise, `session-worktree-lifecycle.js:71-72`):

| Moment | Action | On `diverged` |
|---|---|---|
| **Before fork** (`createBody`) | `fetch origin <base>` (bounded, same timeout as `getBranchSync`), then ff local base from `origin/<base>` when `behind`; proceed on `ahead` (local-only commits are still the base) | fork anyway from local base, emit the existing `worktree-blocked`-style notice as a *warning* not a block: `base main has diverged from origin/main; forked from local` |
| **Before merge-back** (`mergeBackBody`, `mergeContinueBody`) | same fetch + ff of the base, *then* the existing rebase-then-FF of the worktree onto it | PARK with a new reason `base-diverged` (worktree + branch preserved, like the existing conflict park). The sidebar's parked copy names the fix: resync the base by hand, then Merge again |
| **After merge-back** | `push origin <base>` (plain push, never `--force`) | a rejected push (remote moved between fetch and push) leaves the base `ahead`; the indicator shows it, and the next Merge or on-demand resync pushes it. Not an error |

Auto-rebase of live worktrees (`worktreeAutoRebase`) already follows the base when it moves, so a
base that is fast-forwarded from origin before a merge-back propagates to the other sessions
through the existing path. No new poller: fetching happens only at fork and merge-back, plus the
existing on-demand resync.

Fetch failure (offline, auth) at either moment: warn and continue with local state, matching the
`getBranchSync` policy. A fetch failure must never park a merge.

### A4. Call sites

| Site | Today | Change |
|---|---|---|
| `server/session-factory.js:40` | `config.integrationBranch \|\| 'develop'` | `configuredIntegrationBranch(config)` |
| `server/session-registry.js:173` | same fallback passed to `reconcileSessionWorktrees` | resolver; reconcile already trusts the per-worktree marker first |
| `server/branch-gc-poller.js:81` | same fallback per project tick | resolver; with `null`, `listIntegrationTips` adds the detected default per repo (it already unions with `main`/`master`, so the tip set is unchanged for the common case) |
| `session/session-worktree-lifecycle.js:134,265,389` | `integrationBranch` string or null, where null currently means "no worktree isolation" | **null now means auto.** "Worktrees off" moves to the `gitWorkspace == null` check alone (line 265 already tests both; drop the branch test). `effectiveBase` is filled from the marker after create, so the UI always has a real name |
| `server/git-workspace.js` `createBody`, `mergeBackBody`, `mergeContinueBody` | no remote interaction | A3 fetch/ff/push steps |
| `server/posthog-wiring.js:219` | `'the repository default branch'` prose fallback | pass the resolved base into `buildFixPrompt`; keep the prose only when detection returns null |
| `public/sidebar/review-sidebar.js:557` | `ui?.effectiveBase \|\| 'develop'` | `ui?.effectiveBase \|\| 'base'` (a label, never a branch name) |
| `public/sidebar/review-sidebar.js:742` | `'Merge into develop and rebase...'` | template on `effectiveBase`; title gains "and push" |
| comments at `review-sidebar.js:3,85,490`, `config-store.js:77`, `git-workspace.js:194,437`, `control-handlers.js:951,974` | name develop | reword as "the integration branch" |

### A5. Guard against regression

`tests/no-hardcoded-branch.test.js`: greps `server/ session/ shared/ public/` (excluding
`*.test.js`) for `'develop'`, `"develop"`, `into develop` and fails on any hit. After A1 there is no
legitimate hit left, not even in `DEFAULT_CONFIG`.

### A6. Tests

- `configuredIntegrationBranch`: name passes through; `null`/`''`/absent return null.
- `detectDefaultBranch`: origin/HEAD present; origin/HEAD disagrees with local `main` (origin wins);
  no remote but `main`; `master` only; none.
- `createBody` with auto: marker records the detected branch; a second session on the same repo
  reads it; changing the config does not retarget an existing worktree.
- A3, fork: base `behind` is fast-forwarded before the fork and the worktree's base SHA equals
  `origin/<base>`; `diverged` forks from local with a warning; fetch failure forks from local with a
  warning.
- A3, merge-back: base `behind` is fast-forwarded first, worktree rebases onto the new tip, base FFs,
  push happens; `diverged` parks with `base-diverged` and touches nothing; push rejected leaves base
  `ahead` and the result is still `merged: true`.
- `mergeContinue` (keep-working path) gets the same three cases.
- lifecycle: `integrationBranch: null` with a gitWorkspace still creates a worktree.
- settings: `applySettings({ integrationBranch: '' })` stores `null`.
- review sidebar: merge title and "merges into X" render `effectiveBase`; with none they render
  "base"; parked `base-diverged` renders the resync instruction.
- branch GC with auto: tips include the detected default.

### A7. Docs

`AGENTS.md` / `server/AGENTS.md` Worktree sections: "the configured integration branch, or each
repo's default branch when unset; origin is the source of truth for that branch: it is
fast-forwarded from origin before a fork or merge-back and pushed after, and a diverged base is
never touched automatically".

---

## Part B: `/commit` skill goes trunk-only

Model after the change: a commit is made on a feature branch, reviewed, then rebased-and-fast-
forwarded onto mainline and pushed. One hop. No branch is ever created by the skill except the
feature branch preflight asks for.

### B1. Policy

`commit-policy.json` vocabulary changes:

```json
{
  "profile": "personal",
  "commitBranches": { "forbid": ["main", "master"], "onForbidden": "create-feature-branch" },
  "mainline": "auto",
  "afterCommit": "promote"
}
```

- `mainline`: `"auto"` (`origin/HEAD` target, then `main`, then `master`; today's `resolveMainline`
  extended to check `origin/HEAD` first, per decision 4) or a literal name.
- `onForbidden`: `create-feature-branch` only. `switch-to-develop` is removed; a policy that still
  carries it is a preflight refusal naming the profile file, not a silent rewrite. Trunk flow has no
  branch to switch to.
- `afterCommit`: `promote` (rebase-FF onto mainline, push) or `pull-request` (push the feature
  branch, stop). Unchanged meanings, one fewer hop.

Profiles: `personal` and `server` change `onForbidden` and gain `mainline`. `work` stays on
`pull-request`; it drops `develop` from `forbid` (nothing to protect) and gains `mainline`.

### B2. Preflight

`policy.resolved = { mainline: "main" }` in the preflight JSON so `SKILL.md` prose names no branch.
If `mainline` cannot be resolved preflight still returns `READY` with a warning; `land.ts` then
commits and pushes the feature branch and reports `promotion skipped: no mainline`.

Consistency warning, not a gate: if the repo's `.claude/release-profile.yml` names a
`git.integration` other than the resolved mainline, preflight warns. Glissa's own profile is the
first repo this fires on (see step 4).

### B3. `land.ts`

Delete, not generalize:

- `developPresent`, `createDevelop`, `promotionHops`' develop cases, the `current === "develop"`
  checks in `featureBranchForPromotion` and `localPromotionCandidates`, the `--promote-to` flag and
  its `PromoteTarget` type, and the outcome text "develop not updated".
- `promote()` becomes: resolve mainline; if current is mainline, warn and return (the guard should
  have prevented this); otherwise one `promoteHop(current, mainline)`, then push mainline. The
  feature branch is not pushed after a successful mainline promotion (existing rule,
  `land.ts:353-360`).
- `deletedRemoteBranches` (merged `glissa/` branch pruning) tests merged-ness against mainline.

Remote as source of truth (decision 4) in the one hop, which is mostly what `promoteHop` /
`syncDestinationWithOrigin` (`land.ts:505-560`) already do; the change is the diverged case:

| Local mainline vs `origin/<mainline>` | Today | After |
|---|---|---|
| behind | ff local from tracking, continue | same |
| in sync | continue | same |
| ahead (local-only commits on mainline) | `handleDestinationOriginUpdate` decides | **refuse**: new outcome `MAINLINE_AHEAD` listing the local-only SHAs. Remote is the truth; local commits that never reached origin are the operator's to push or drop by hand, and the skill must not launder them into a promotion push |
| diverged | conflict outcome | same: `PROMOTE_CONFLICT`, nothing touched |

After the hop, `push origin <mainline>` is a plain push; a rejection (remote moved between fetch and
push) is `PROMOTE_FAILED` with the feature branch pushed as a fallback, which is the existing
`pushFeatureAfterFailedMainlinePromotion` path. Never `--force`, never `--force-with-lease`.

### B4. `SKILL.md`

Rewrite the branch-guard and `--promote` sections: remove the `switch-to-develop` bullet and the
`--promote-to develop` bullet; "carries the commit through develop into main/master" becomes
"rebases and fast-forwards the feature branch onto `policy.resolved.mainline` and pushes it".
Document `MAINLINE_AHEAD` in the outcome table with its remedy.

### B5. Tests (`skills/commit/test`)

- policy: `switch-to-develop` refuses with the profile path in the message; `mainline` literal and
  auto both resolve; `origin/HEAD` preferred over a local `main` when they differ.
- promote: feature -> main in one hop; a `develop` present in the repo is ignored and untouched;
  `develop` absent stays absent; current == mainline warns and skips; no mainline commits + pushes
  the feature branch with the warning.
- remote truth: mainline `behind` is fast-forwarded before the hop; `ahead` returns
  `MAINLINE_AHEAD` and touches nothing; `diverged` returns `PROMOTE_CONFLICT`; push rejection returns
  `PROMOTE_FAILED` with the feature branch pushed.
- `--promote-to` is rejected as an unknown flag.

---

## Sequencing

1. A2 + A4 + A5 with `DEFAULT_CONFIG` still `'develop'`. Pure refactor; existing tests pass
   unchanged except the grep gate, which is added last in this step.
2. A1 + A3 + A6 + A7: `null` = auto, lifecycle null-meaning change, settings normalization, the
   fetch/ff/push steps.
3. B1 to B5 in `claude-setup`; profiles updated in the same change; `setup/apply` re-run on each
   machine.
4. Glissa repo housekeeping now that commits land on `main`: `.claude/release-profile.yml`
   `release_from`/`integration` -> `main`, drop the post-release "sync main" step; this machine's
   `~/.glissa/config.json` `integrationBranch` -> `null`. Session worktrees still parked on
   `develop` finish through their marker (it names their base), so no session needs restarting.
   `develop` itself stays (decision 5).

Steps 1-2 and 3 are independent and can run as separate sessions; 4 waits on both.

## Resolved in review (2026-08-30)

1. A3 before-fork on `diverged`: **fork from local with a warning**, so a session can still start
   offline or mid-resolution.
2. B3 `MAINLINE_AHEAD` **refuses**. Pushing local mainline first would silently publish whatever
   happens to be sitting on local `main`, which is exactly what remote-as-truth forbids.

## Implementation notes (2026-08-30, after review)

Both parts landed on feature branches after two independent review rounds each. Deviations from
the text above, all deliberate:

- **Before-fork sync is upstream's.** Commit 651b17f (another session) shipped a create-time and
  fresh-restart sync (`server/core/integration-sync-core.js`, `worktreeSyncOnStart`) while this
  work was in flight; our duplicate was deleted and the auto-detected base is routed through it.
  That path refuses to fast-forward a base that is checked out in the main checkout (unattended
  code must not touch the operator's working tree), so a fork from a checked-out `main` starts
  from the local tip with a warning instead of the A3 "ff-merge when checked out". Merge-back and
  keep-working still sync through the operator-invoked path, which does ff-merge a checked-out base.
- `createBody` takes an explicit `forkFromHead: true` (PR review) instead of an omitted `baseBranch`;
  `baseBranch: null` means auto everywhere.
- `/commit`: `MAINLINE_AHEAD` and `PROMOTE_CONFLICT` push the feature branch as a fallback (mainline
  untouched) rather than "nothing touched", so work is never stranded locally. New typed outcomes:
  `POLICY_INVALID` 27, `BRANCH_FORBIDDEN` 28 (also when the current branch is the resolved mainline
  even if not in `forbid`), `MAINLINE_UNVERIFIED` 29 (fetch failed or origin has no mainline: never
  create it). A mainline present only on origin is materialized locally as a tracking branch.
  `--no-push` suppresses every push. Preflight reads `.claude/release-profile.json` first, `.yml` as
  the retired fallback.
- Step 4's `release-profile.yml` edit rides on the feature branch. The machine config
  (`~/.glissa/config.json` `integrationBranch` -> `null`) is left for the operator.
