<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# sidebar

## Purpose
The review sidebar: the single home for the worktree review gate of the selected session. Shows a changed-files summary over collapsible per-file diffs plus the actions (Merge into the integration branch without ending the session; Discard for a settled worktree). App-level, shared by every view. Right-docked on the desktop layout; the SAME element is re-parented into the phone Review screen (`reparentReviewPanel`), so both layouts are one review surface with one set of caches and listeners.

## Key Files

| File | Description |
|------|-------------|
| `review-sidebar.js` | DOM module: summary, per-file collapsible diff markup, Merge/Discard actions |
| `diff-core.mjs` | Pure unified-diff parser: `git diff` text -> file sections with hunks and typed lines; no DOM |
| `selection.js` | Single source of truth for the selected session id, with subscriber notification; shared by grid clicks and Focus pill focusing |

## For AI Agents

### Working In This Directory
- Selection goes through `selection.js` only; never track a competing "current session" elsewhere.
- `diff-core.mjs` stays pure and dependency-free (node:test runs it); rendering belongs in `review-sidebar.js`.
- Merge semantics live server-side (rebase-then-FF, park on conflict, `session/core/merge-prompt.ts` handoff); the sidebar only sends control messages and renders results.
- Diff text renders via textContent/escaped markup; never innerHTML raw diff content.
- The panel is built once and MOVED between layouts, never rebuilt. It has no close control in either one (the desktop dock is permanent; the phone screen is dismissed by the bottom nav), so do not reintroduce a dismiss button without a layout that needs it.

### Testing Requirements
- `tests/frontend-diff-core.test.js` for the parser; merge flow verified end-to-end via `npm run dev` with a worktree session.

## Dependencies

### Internal
- `../control-ws.js` (merge/discard/diff requests), `../session-card/` (per-card merge state), `../app.js` (Alt+M shortcut)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
