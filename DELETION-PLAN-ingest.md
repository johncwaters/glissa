# Deletion plan: ingestion subsystem

Baseline: 11 modules + 1 shared number core + tail core = ~4700 lines of source, ~5000 lines of tests.

## What the subsystem actually feeds

Exactly two consumers, both reading ONLY `summary`, `source`, `ts`, `seq`, `scope`:

- `server/navigator-wiring.js` -> `buildDigest()` -> one fenced DATA section in the dispatch prompt, plus
  `latestSeq()` as the movement signal for `decideDispatch`.
- `public/navigator-panel.js` -> the Navigator tab activity feed, via `ingest-snapshot` / `ingest-activity`.

`public/navigator-view-core.mjs normalizeActivityEvent` drops every field it is not listed above. Nothing
anywhere reads `event.detail`.

## Dies

1. **The `shellHistory` source, entirely.** `server/ingest-shell-history.js` (471) +
   `server/core/ingest-shell-core.js` (411) + `tests/ingest-shell-history.test.js` (602) +
   `tests/ingest-shell-core.test.js` (325), its lane wiring, its config keys, its `keepEmptyLines` branch
   in the tail core, its rows in the plan doc, and its cases in `ingest-backend.test.js` /
   `ingest-core.test.js`. Why it is the one to go: it is off by default even with the lane on, it is the
   only source reading data created outside glissa's own surfaces, and its events can NEVER carry a
   project root, so every one of them is machine scope and lands in every project's digest unfiltered.
   Four bespoke history-file parsers, a HISTFILE resolver and an rc snippet the operator has to install
   by hand buy one weakly-correlated digest line. `~1810 lines`.
2. **The `editor` source.** Declared in `SOURCE_NAMES`, `KINDS_BY_SOURCE`, `SOURCE_DEFAULTS` and both
   label maps; no adapter has ever published it and the navigator lane it was meant to come from does not
   call `publish`. Pure speculative generality. `~25 lines`.
3. **`event.detail`, end to end.** Built by every source, scrubbed by `scrubDetail`, bounded by
   `MAX_DETAIL_CHARS` / `MAX_DETAIL_KEYS`, carried on the wire, and read by nobody. Deleting it also
   deletes `countByKind` / `sampleOf` in the fs core, `detail.text` plus `maxTextChars` in the terminal
   core, the dropped-lines detail merge in the agent-log shell, and the per-event detail objects in the
   git and agent cores. `~130 lines` plus test churn.
4. **The fs burst hash set.** `MAX_UNTRACKED_KEYS`, `untrackedKey` (sha1 per path), `batch.untracked` and
   the `floored` bookkeeping exist only to count distinct files exactly between 2000 and 10000 in a window
   that already publishes ONE summarized line. Replaced by a counter that stops at `MAX_TRACKED_FILES` and
   says `at least 2000 files changed`. Removes a sha1 per path from the storm path. `~40 lines`.
5. **`ringStats`** (core + lane getter): no consumer outside its own tests.
6. **`latestSeq(store)`**: a five-line `Number.isFinite` wrapper over `store.seq`, which the core itself
   only ever assigns integers to. Folded into the lane.
7. **Dead exports and knobs**: `VENDORS`, `KIND`, `IGNORED_FILE_NAMES`/`IGNORED_FILE_SUFFIXES`,
   `CONFIG_HOLDER`, `DEFAULT_MAX_ROOTS`, `DEFAULT_MAX_REPOS`, `DEFAULT_GIT_TIMEOUT_MS`,
   `MAX_GIT_BUFFER_BYTES`, `CODEX_HEAD_BYTES`, `DEFAULT_ACTIVE_WITHIN_MS`, `fileIdentity`,
   `DEFAULT_MAX_TRACKED` (tail core), plus the agent-log constructor's `maxScanDirs`, `maxWatchedDirs` and
   the doubled `pollIntervalMs` fallback nothing passes.

## Folds

- `pickEvent` + `subjectSuffix` into `decideGitEvents`'s three builders (single caller each).
- `burstSummary`/`countByKind`/`sampleOf` into `decideFsEvents`.
- `disabledSource`/`disabledConfig` in the config resolver.

## Stays, deliberately

- `terminal`, `agentLogs`, `git`, `fs` sources: each has a live consumer path and unique coverage
  (agentLogs is the only reader of agent CLIs glissa did not spawn).
- The scrub corpus and its two pattern lists: the terminal source can carry every shape the shell source
  could.
- Per-source ring caps, the tail catch-up bound, the repaint segmenter: all load-bearing bounds.

## Expected delta

Roughly -2100 source lines and -1300 test lines.
