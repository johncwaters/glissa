## GitHub release draft

**Tag:** `v0.15.0`
**Title:** `v0.15.0`
**Repository:** `johncwaters/glissa`

Paste the following into the GitHub "Draft a new release" form as the release body. State the tag `v0.15.0` when creating the draft; do not create or push the tag until you are ready to publish.

---

v0.15.0 adds a built-in changelog team and fixes two reliability issues in the teams pipeline that caused run output to get stranded and stage status to stall between stages.

## Added

**Changelog team**: A new on-demand pipeline keeps your CHANGELOG accurate against git history. Four stages run in sequence: an analyst reads your existing changelog and the commits in the configured range, then writes a sourced analysis of what is missing, inaccurate, mis-categorized, mis-ordered, or correctly excluded; a curator edits the changelog file in place to add, correct, move, merge, and reorder entries so every one traces to a commit; an auditor re-derives the commit list from read-only git and gates on accuracy, format, and style with a SHIP/FIX/BLOCK verdict and a bounded FIX loop back to the curator; a reporter writes a short summary on a final SHIP. The curator's edit lands only on a final SHIP, scoped to changelog-shaped files (CHANGELOG.md, CHANGES, HISTORY, NEWS, and nested variants), so a passing run cannot pull in source, tests, or config. On FIX or BLOCK the edit is discarded and only the run folder and log merge back. Like the existing marketing, release-notes, and qa teams, it ships as data plus role markdown plus pack templates with no engine changes.

## Fixed

**Team run output now lands in your project**: A finished team run was committed on its throwaway worktree branch but never merged back, leaving the run stranded and its output lost. The pre-run setup gate writes a header-only log file into the project tree before the worktree exists, which left it untracked, and `git merge --ff-only` refused to overwrite that untracked file, aborting the merge-back. The run engine now clears the blocking untracked files before the fast-forward, scoped so your project's own pack files and other untracked files are never touched.

**Live Teams run status between stages**: While a team run waited for the next stage's headless session to spawn (which can take several seconds), the Teams view header stayed stuck on the finished stage. The header now shows the handoff in progress (for example "Writer done, starting Editor"), suppressing the next-stage hint after a verdict stage where a FIX may re-run an earlier stage. A reduced-motion-safe completion cue pulses on the run-to-done transition, scoped to the status text rather than the whole panel.

---

## Announcement draft

**Channel:** X / Twitter

Glissa v0.15.0: a built-in changelog team that checks your CHANGELOG against git history, plus two teams pipeline fixes so run output lands reliably and the status header no longer stalls between stages. https://github.com/johncwaters/glissa
