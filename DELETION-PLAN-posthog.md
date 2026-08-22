# Deletion plan: PostHog / Radar monitoring lane

Baseline: 2722 server lines across the five lane files, plus 165 in `core/traffic-spike-core.js`,
614 in `public/radar-panel.js`, 347 in `public/radar-core.mjs`, and ~4500 test lines.

## Dies (whole features)

1. **Recurrence dedupe and escalation** - `server/core/posthog-recurrence.js` (307) +
   `tests/posthog-recurrence.test.js` (412) + its poller half + `recurrenceDedupe`,
   `recurrenceWindowDays`, `transientRecurrenceLimit` config keys + `entry.recurrenceOf` +
   `_signatures` state slice + the `recurrence_escalated` ping.
   Justification: ~800 lines of Jaccard token matching, generic-token stoplists, build-hash
   heuristics, corroboration thresholds and an escalation ladder, all to avoid re-spawning a session
   for an error that a prior investigation called TRANSIENT. `planInvestigations` already bounds
   spawning; a fuzzy title match guessing "same incident" is a lot of machinery for a saved session,
   and a false positive silently swallows a real bug.

2. **Traffic spike / traffic climbing detection** - `server/core/traffic-spike-core.js` (165) +
   `tests/traffic-spike-core.test.js` (247) + `api.queryTrafficBuckets`/`runHogQL`/
   `clampBaselineDays` + the poller's `tickTraffic` + `trafficSpikeEnabled`, `trafficSpikeMultiplier`,
   `trafficSpikeMinUsers`, `trafficSpikeCooldownMinutes`, `trafficSpikeBaselineDays` + the Settings
   block and the two ping labels.
   Justification: a product-analytics feature living inside an error-monitoring lane. It has no
   dashboard surface, drives no investigation and takes no action: two HogQL queries per project per
   tick produce a Telegram line and nothing else, behind five tuning knobs. ~550 lines for two
   notification strings.

3. **`worsened` classification and `userEscalationThreshold`** - the classify branch, both
   `planInvestigations` threshold branches, the rank/severity/label entries in the Radar UI, the
   Settings field and the control-WS key.
   Justification: one knob whose whole job is re-investigating an already-diagnosed issue when its
   user count crosses 25. The issue's own regression and spike signals already trigger that, and the
   threshold touched five files to do it.

4. **Session auto-creation by directory-name guessing** - `slugKey`, `isAbsolutePathish`,
   `projectParentDirs`, `pickDirectoryForProjectName`, `sanitizeSessionName` in the core plus
   `listSiblingRepoDirs` / `autoCreatePosthogProject` in `control-handlers.js`.
   Justification: ~180 lines that scan the parent folders of every configured project, slug-match
   directory names against a PostHog project name, refuse on ambiguity, and mint a config entry.
   `posthog.projectMap` already answers the same question explicitly, and Open session falls back to
   naming that key.

5. **Archive-as-tombstone** - the `archived` / `archivedAt` fields, `archivedRetentionDays`,
   `pruneInvestigations`, `unarchivedInvestigations`, `retainKnownInvestigationIds` and the panel's
   `_archivedLocally` set. Archive now REMOVES the record.
   Justification: three retention mechanisms (newest-50 cap, archived-record aging, a client-side
   suppression set) for a review queue whose rows the operator dismisses by hand. A removed record
   needs none of them.

6. **Dead API surface** - `listRecommendations` (never called), the positional HogQL matrix branch of
   `extractRows` (only the deleted traffic queries produced one), and the alias hedges in
   `normalizeIssue` down to the fields the endpoint documents.

7. **`decideJobMode({ hasRepo })`** - a config branch with no caller: the real downgrade is
   `posthogFixSpawn` returning null when there is no repository.

## Folds

- `OBSERVATION_PINGS` table (two entries with a dedupe flag) inlines into the tick loop.
- `planIssueActions` (recurrence's wrapper over `planInvestigations`) folds back to
  `planInvestigations`.
- `pruneSignatureRegistry` / `pruneInvestigationLog` collapse to the one cap the log still has.

## Stays (non-negotiable)

The ids-only injection fence in both prompts, `FIX_DENY` denying `git push` and every `gh`, the
server-side push/PR-create through `child-process-safe` argument arrays, the `.github/workflows/`
refusal, and the worktree discard on every exit path.

Also kept: spike detection (cheap, and the one "wake me now" signal), the investigations inbox and
its reports, the resolve/suppress writes, Open session, per-issue history sparklines, the render
hold.

## Expected delta

Roughly -1700 server/UI lines and -1400 test lines, with the lane's five config knobs cut from
sixteen to eight.
