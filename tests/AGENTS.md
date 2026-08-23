<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# tests

## Purpose
The automated test suite, run with `npm test` (node:test, no test framework dependency). Covers the pure cores, detection stack, session lifecycle, and the frontend's pure `.mjs` modules. Recorded-session fixtures drive the version-aware replay harness.

## Key Files
Tests are named `<module>.test.js` after the module under test. Notable clusters:

| Cluster | Files |
|---------|-------|
| Detection | `status-source`, `hook-source`, `osc-title-source`, `replay-harness`, `worktree-detection`, `worktree-watch`, `integration-ref-watch`, `title-latch-recovery` |
| Session core | `state-machine`, `status-mapper` (via `sessions-detection`), `agent-tracker`, `wakeup-tracker` (via `pending-wakeup`), `spawn-command`, `spawn-env`, `spawn-gate`, `spawn-integration`, `merge-prompt`, `anti-slop-prompt`, `post-turn-rules`, `slop-code-patterns`, `post-turn-checker` |
| Session/server | `sessions-buffer`, `sessions-worktree`, `session-resize`, `session-write-guard`, `ws-sender`, `control-worktree` |
| Worktrees | `git-workspace-session`, `git-workspace-rebase`, `rebase-gate`, `sessions-auto-rebase`, `session-spawn-args`, `no-direct-git-worktree`, `backend-worktree-reconcile` |
| Usage tracking | `usage-entry-core`, `usage-pricing-core`, `usage-aggregate-core`, `usage-blocks-core`, `usage-scan-core`, `usage-scanner`, `usage-pricing`, `backend-usage`, `control-settings-usage`, `frontend-usage-view` |
| Frontend pure cores | `frontend-naming`, `frontend-webgl-pool`, `frontend-aggregate-status`, `frontend-attention-roster`, `frontend-diff-core`, `roster-groups-core`, `focus-shortcuts-core`, `shortcuts-core`, `render-scheduler`, `perf-corpus` |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `fixtures/` | JSONL session recordings (v1 legacy and v2 structural-signal format) consumed by `replay-harness.test.js` |
| `helpers/` | Shared test fixtures that are not themselves tests (the `*.test.js` glob skips them). `short-path.js` mints 8.3 aliases so the CI runner's short `%TEMP%` is reproducible locally; `transcript-homes.js` redirects the three vendor transcript homes, which every boot with `memory.enabled` needs since that switch implies the agent-log source |

## For AI Agents

### Working In This Directory
- node:test only: `test()`/`describe()` from `node:test`, `assert` from `node:assert`. No jest/mocha/vitest.
- Tests assert on pure modules or injected fakes; no real PTY, no network, no live `claude`. Git-touching tests build temp repos.
- No-dash rule applies to test sources too: build em/en dash/ellipsis expectations via `String.fromCharCode`, never literals.
- New detection scenarios get a fixture recording plus a replay assertion, not a hand-rolled signal sequence only.
- Frontend `.mjs` cores are dynamic-imported from `../public/`; keep them DOM-free or these tests break.

### Testing Requirements
- `npm test` runs the whole suite; `node --test tests/<file>` runs one file.

## Dependencies

### Internal
- Everything under test: `../server/`, `../session/`, `../notifications/`, `../session/core/`, `../detection/`, `../public/**/*.mjs`, `../shared/`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
