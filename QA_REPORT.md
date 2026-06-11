# QA Report: perf-improvements (6 items, 4 commits)

**Verdict: PASS**
**Date:** 2026-06-11
**Diff range:** c96487a..HEAD (338a5a8, d8d2e51, dd2d347, 3f7c01e)
**Plan:** `.omc/plans/perf-improvements.md`

---

## Test Run

```
npm test
730 pass / 0 fail / 0 skipped
duration: 11652ms
```

## Build

```
npm run build
44 modules transformed, exit 0, 801ms
```

---

## Per-Item Checklist

### Item 1 (HIGH): Async session worktree git

- [x] No `execFileSync`/`execSync` git on recurring paths. The two remaining `execFileSync` in `sessions.js` are `_resolveCommonGitDir` (line 470) and `hasChanges` (line 578), both one-shot cold paths explicitly permitted by the plan.
- [x] Serialize queue present (`team-git.js` lines 48-53); wraps `create`, `integrate`, `discard`, `mergeBack`, `mergeKeep`, `restoreTests`, `removeWorktreeByPath`. Comment at line 211 references the queue.
- [x] All required methods async: `_provisionWorktree`, `_settleWorktreeOnExit`, `mergeWorktree`, `mergeAndContinue`, `discardWorktree`, `start`, `_handlePtyExit`, `_mergeAndReset`, `_discardAndReset`.
- [x] `_handlePtyExit` anti-deadlock: `try { await settle; } catch {}` always reaches `emit("exit")`.
- [x] Settled-branch mutex: `_finishing`/`_pendingPark` set synchronously before async reset, cleared in `.finally()`.
- [x] `createGitWorkspaceSync` sibling used for boot reconcile in `backend.js`.
- [x] All 4 `finalize(...)` call sites in `team-orchestrator.js` awaited.

Required tests (all PASS):
- serialize: two concurrent mutating calls on one engine run strictly sequentially
- start(): destroy() during the provision await -> no spawn
- mergeWorktree re-entry: a second call while merging is refused, engine invoked once
- mergeWorktree guard does NOT block the finish path (pending-review -> merge runs)
- _handlePtyExit: settle completes before "exit" is emitted (changed tree)
- _handlePtyExit: a rejecting settle still emits "exit" and clears the teardown flag (no deadlock)
- finishAndMerge settled-branch mutex: a double-click is refused, engine merges once
- parkToDormant settled-branch mutex: a double-click is refused, engine discards once
- async engine: finalize is awaited on success (merged defined) and on cancel (discard completes)

### Item 2 (MED): Async taskkill

- [x] No `execSync` for taskkill in `sessions.js`. All 4 sites use `this._taskkill()` via injected `_killProc` with array args `["/PID", pid, "/T", "/F"]`.
- [x] `kill()` flips `_ptyAlive = false` and schedules `_forceKillAfterTimeout` synchronously before the async kill.
- [x] `killProc` seam injected via constructor option, asserted in tests.

Required tests (all PASS):
- kill() invokes the injected killer with the taskkill array args
- kill() flips _ptyAlive to false synchronously BEFORE invoking the killer
- _handlePtyExit reap is fire-and-forget: the exit emit is not delayed by the killer
- _forceKillAfterTimeout fires the killer once when the process outlives the budget

### Item 3 (LOW): Skip health snapshot at zero control clients

- [x] `backend.js` line 310: `if (controlWss.clients.size === 0) return;` after the `refreshGitContext` loop, before `buildHealthSnapshot()`.
- [x] `refreshGitContext` loop runs unconditionally.
- [x] `request-health-snapshot` and connect paths untouched.

### Item 4 (LOW): Gate health snapshot render on visibility

- [x] `applyHealthSnapshot` stores `_latest` then early-returns if `!_root || _root.hidden`.
- [x] `setHealthMonitorVisible(on)` renders once on reveal when `on && wasHidden && _latest`.

### Item 5 (LOW): Focus roster pill ref caching

- [x] `buildPill` sets `pill._refs` with 4 cached span refs.
- [x] `paintPill` reads `pill._refs.glyph/label/name/merge` - zero `querySelector` calls.
- [x] `renderPillActivity` reads `pill._refs?.glyph` - no `querySelector` on heartbeat path.
- [x] `placeList` helper skips `appendChild` when order key unchanged; `paintPill` still runs every refresh.

### Item 6 (LOW): Render-scheduler chunk array

- [x] `pending` replaced with `[]` array + `pendingBytes` counter. `enqueue` pushes. Servicing accumulates from the front with byte-exact split on overflow.
- [x] All 7 original tests pass unchanged.
- [x] New boundary tests pass: multi-chunk cap crossing, straddle split, large backlog regression guard.

---

## Source Hygiene Gate

| Check | Result |
|-------|--------|
| em dash (U+2014) in added lines | 0 |
| en dash (U+2013) in added lines | 0 |
| ellipsis (U+2026) in added lines | 0 |
| emoji in added lines | 0 |
| NUL bytes in added lines | 0 |
| New bare `else` blocks in production code | 0 |
| `package.json` changes | none |

---

## Gaps

None. All acceptance criteria verified with fresh evidence.
