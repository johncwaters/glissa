# Deletion plan: worktree merge/rebase machinery

**Scope ruling applied mid-pass: no feature and no config key may be deleted.** Everything below that
would have removed operator-visible behavior is therefore marked "declined (scope)", and what shipped
is behavior-preserving only: dead code, duplication folds, and redundancy folds where one mechanism
provably subsumes another.

Scope: `server/git-workspace.js`, `session/core/{merge-gate,rebase-gate,merge-prompt}.js`,
`server/core/branch-sync-core.js`, `detection/{worktree-watch,integration-ref-watch,integration-watcher-pool,watch-debounce}.js`,
the worktree half of `session/sessions.js` + `server/backend.js`, and their tests.

Classification: **(a) incident-pinned** (a regression test encodes an observed failure; behavior kept,
implementation may be simplified), **(b) speculative** (defends against never-observed input, nothing
pins it), **(c) redundant** (another mechanism already covers it).

## Classification table

| Mechanism | Class | Verdict |
|---|---|---|
| rerere replay + binary-conflict completion proof (unmerged-paths, never `git rerere remaining`) | a | keep verbatim; `tests/git-workspace-rebase.test.js` reproduces the silent-skip commit loss |
| `rebase --skip` on an emptied patch | a | keep (pinned: `--continue` strands the rebase) |
| `rebaseOnly` never stashes; dirty = hard refusal | a | keep (pinned, and the whole point of the unattended path) |
| Serialized engine queue (`serialize`) | a | keep; only the per-method wrapper boilerplate is collapsed |
| Conflict cooldown key `head::target` | a | keep (pinned: doomed rebase retried on every nudge) |
| `_autoRebasing` funnel suppression + always-one-recheck | a | keep (pinned: mid-rebase read self-heals a real gate to `none`) |
| `decideAutoRebase` guard order / WAITING exclusion | a | keep (the tests are the statement of the order) |
| `decideSignatureDemotion` (demotion before the sig dedup) | a | keep (pinned: `parked` sticks forever otherwise) |
| Eager auto-rebase layer as a whole | feature, not a defense | **keep** (and declined by the scope ruling): it is what pays drift off in small pieces; the merge-time replay only helps once the operator clicks Merge, which is exactly the late, large conflict this exists to avoid. Untouched. |
| `worktreeRerere` kill switch / `createGitWorkspace({ rerere })` | c | **declined (scope)**: it is redundant with git's own `rerere.enabled=false`, which Glissa already respects (it seeds the key only when unset, and with rerere off the replay loop bails on its first unmerged-path check), but it is a live config key, so it stays. |
| `integration-watcher-pool.js` (ref-count + sibling fan-out) | c | **deleted**: a session already owns a debounced fs.watch (its gitdir); the reflog watch is the same lifecycle on a second directory, so it moved next to it (`sessions.js _startWorktreeWatcher` / `_stopWorktreeWatcher`). The ref-count only ever saved one fs.watch handle per repo, and the fan-out additionally re-checked siblings on a *different* integration branch, whose gate a move of this branch cannot change - so the observable outcome is identical. |
| `config.liveWorktreeReview` kill switch | b | **kept and preserved**: the key is in no default, no settable list and no doc, but it is still a key an operator could have hand-written, so it survives as the `liveWorktreeReview` Session option that gates the reflog watcher. |
| `Session.get integrationBranch()` accessor | c | **deleted**: existed only so the pool could group sessions; nothing else read it. |
| `worktreeHasWork` + `readIntegrationMarker` + the session-branch prefix, once per engine | c | **folded**: one `hasWorkFrom` / `markerFrom` / `sessionIdFromBranch` at module scope, so the async and the sync boot engine cannot drift on the rule they both apply (the dirty short-circuit is preserved: the ahead-count is still only asked for on a clean tree). |
| Watcher-side debounce (`watch-debounce.js`) in series with `_scheduleWorktreeCheck` | c (partial) | **keep, declined**: fs.watch emits several events per single write, so the coalescing is load-bearing at the watcher; the session timer also serves the turn-end hook, which has no watcher. Collapsing them would delete coalescing assertions from two watcher test files that pin real fs.watch behavior - test churn out of proportion to ~15 lines. |
| `createGitWorkspaceSync` (duplicate list/remove engine for the cold boot reconcile) | c | **keep, declined**: deleting it makes `reconcileSessionWorktrees` async, which re-orders boot (reconcile -> ingest poke -> auto-resume) and forces `await` into every `tests/backend-worktree-reconcile.test.js` case. That is a kept-behavior test rewrite, which this pass is not allowed to do. Flagged as the next honest deletion. |
| `branch-sync-core.js` parsing generality | b (thin) | **keep**: every branch has a test; the only untested line is the OSC strip inside `firstGitErrorLine`. Deleting covered branches would mean deleting tests for a mechanism that stays. |
| `merge-prompt.js` reason table | a-ish | keep: every reason string is reachable from a real park result. |
| Decision-trace entries (`auto-rebased` / `conflict` / `state-moved`) | a | keep: all three pinned, and the trace is the only post-hoc record of an unattended rewrite. |
| `mergeWorktree` / `mergeAndContinue` engine preamble | c | simplify in place: one `_runMergeEngine` shared by both (guard-free, same results). |
| Six `x(args) { return serialize(() => xBody(args)) }` wrappers | c | simplify in place: one `serialized()` combinator. |

## Invariants that survive this pass unchanged

`git-workspace.js` stays the only module shelling `git worktree`; all git via `child-process-safe`;
the serialized engine queue; never stash in an unattended path; never resolve a conflict beyond a
replay git already recorded; dirty tree = hard refusal for the unattended rebase; the completeness
proof stays "no unmerged paths remain".
