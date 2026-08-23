# Monitoring Report: Context Mill + Visions Ingestion

Standing bug-watch report. Findings only, no fixes applied. Updated by the monitoring loop each pass.

- Last pass: 2026-08-22 (pass 1, full audit)
- Baseline HEAD at audit: 204a9da (branch glissa/session/5290c049), recent scope commits reviewed through 6be6370, bf13fdb, 04820ad
- Method: two independent opus audit agents (context mill, Visions lane), findings probe-confirmed where stated, all pack tests (142) and visions/ingest tests (225) passing

## Visions Lane

### V1 [CRITICAL] cmd.exe command injection from markdown buffer content on the shim spawn path
`server/core/visions-dispatch-core.js:331-333` embeds the raw buffer in the dispatch prompt; `server/visions-dispatch.js:197-203` passes it as `initialPrompt`; `session/sessions.js:2142-2143` puts it in argv; `session/core/spawn-command.js:100` routes a `.cmd`/`.bat`/`.ps1` claude install through `cmd.exe /c`. node-pty escapes `"` as `\"` (MSVCRT quoting) but cmd.exe only counts quotes, so an odd quote count in the buffer drops cmd into unquoted state and a following `&`, `|`, `>` executes as a command. Scenario: operator opens a hostile markdown file (e.g. containing `" & calc.exe & "`) with dispatch enabled and a shim-shaped claude install; the quiet-window dispatch executes the payload as the daemon account. Conditions: `visions.enabled` + `visions.dispatch.enabled` (both default off) + shim install. The `.exe` path is safe. Note the repo already guards this hazard elsewhere (`anti-slop-prompt.js` deliberately avoids double quotes) but the one prompt built from attacker-controlled text has no guard.

### V2 [MAJOR] No size cap on the buffer-in-argv, dispatch fails on real documents and burns its budget doing so
`visions-dispatch-core.js:299-347` caps everything except `text`. Windows command line limit is 32767 chars; this repo's own AGENTS.md (128KB) and docs/plan-ingestion.md (59KB) cannot dispatch at all. The failure is quiet (one warn) and, because `recordDispatch` runs before the await, still consumes the 5-minute cooldown and one of 6 hourly slots. The lane burns budget failing on exactly the long documents it exists for.

### V3 [MAJOR, low-confidence] `--allowedTools=Write` is not a write boundary
`server/visions-dispatch.js:41-48` pre-approves Write with no path scoping; the module's own probe note (lines 12-14) records that path-scoped allow rules do not narrow writes. Combined with V1's attacker-controlled DATA section, an obedient session can write any absolute path as the daemon account (`~/.claude/settings.json`, shell profile). Needs one headless confirm run.

### V4 [MINOR] `empty-document` gate is dead code
`visions-dispatch-core.js:149` checks `!textHash`, but `hashText('')` returns truthy `"0-ztntfp"`. Empty/whitespace .md file idles 30s, spawns a session to comment on nothing, consumes cooldown + hourly slot. Test only passes by hand-feeding `textHash: ''`, a value the wiring cannot produce.

### V5 [MINOR] ERROR verdict still moves the machine-wide intent statement
`visions-dispatch.js:82-86` returns intent/hand for every verdict; `visions-wiring.js:535-538` applies `applyModelIntent` before the `!recorded` return. A confused session writing `{"verdict":"ERROR","intent":"..."}` is refused for comments yet still rewrites, broadcasts, and persists the intent. No test covers it.

### V6 [MINOR] Tier 3 comments/diagnostics have no freshness guard
`visions-wiring.js:531-535` only checks buffer existence after the up-to-180s dispatch. Tier 1 fixes have `isFixSetFresh`; tier 3 output re-anchors to whatever text now sits on those line numbers.

### V7 [MINOR] Oversized didOpen wedges the relay in a 500ms reconnect loop
Server socket cap is 2MB (`visions-wiring.js:41,162`, close 1009); `session/visions-relay.js:201-221` resets backoff to 500ms on open and replays all docs before the close lands, so backoff never advances. A >2MB buffer produces a permanent 500ms multi-MB reconnect cycle.

### V8 [MINOR] DATA fence marker is a 32-bit hash, fixed-point forgeable
`visions-dispatch-core.js:271-274`. Roughly 2^32 offline hash evaluations can craft a buffer containing its own fence marker. The comment states the property as absolute; a 128-bit digest removes the class.

### V9 [MINOR] didClose from one relay wipes shared per-uri state for another
`visions-wiring.js:737-753` clears wiring-scoped maps (findings, comments, hands, fixes, cooldown) while doc stores are per-connection. Two editors on the same file: closing in one blanks the other's tab section and resets the dispatch cooldown.

Notes (not findings): line-splitting disagreement for CR-only files between dispatch-core (`\n` only) and buffer store (honors lone `\r`); `dropModelDiagnostics` on didChange does not republish (stale tab up to one debounce window).

### Visions contract checks
Holding: lane gated on `config.visions.enabled`; remote-listener refusal via port trust; Origin checked on visions upgrade; dispatch gated on `dispatch.enabled`; no skip-permissions, deny list, hard timeout with destroy; result-contract validation (shape, verdict, line range, empty messages, all-invalid downgrade to NONE); UTF-16 splice with LSP clamps, batch all-or-nothing, monotonic versions; scope match decodes percent-encoding before dot-segment collapse; autoFix defaults off; intent lock semantics; parcel-watcher ignores applied at subscribe, load failure disables one source only.
Not fully holding: DATA fence (V8), result contract vs intent (V5), stated cwd write boundary (V3).

### Visions recent-commit risks
- `bf13fdb` (Navigator to Visions rename): clean in code, but `config.navigator` to `config.visions` has no migration or warning; an upgrading install silently loses the lane + dispatch + autoFix. Stated as a deliberate clean break; operator-invisible either way. Disposition question.
- `04820ad` (incremental LSP sync restore) and `27b6077` (bounds-order fix): reviewed closely, correct, no regression found.
- `de9d4d3` (ingest surfaces revert): consistent with its core.

## Context Mill

### M1 [MAJOR] Publish that fails after rotation destroys `current/` entirely
`server/pack-builder.js:240-247`: `publishBuild` renames `current` to `previous`, then renames tmp in. If the second rename fails (probe-confirmed with forced EPERM), the pack has no `current/`; every later spawn silently skips the pack. Realistic triggers: concurrent-build tmp deletion (M2), Windows lock on the tmp tree, process kill in the window (`backend.js:1921` does not await `packService.stop()`). Worst at boot: `scheduleAutoResume()` (backend.js:1410) runs before `packService.start()` (:1421), neither awaited, so auto-resumed sessions can spawn pack-less until the first sweep republishes.

### M2 [MAJOR] `clearStaleTmpDirs` deletes any process's in-flight tmp dir, no cross-process lock
`pack-builder.js:217-228` (called at :234) rm-rfs every `tmp-*` with no ownership check. The promise chain serializes one process only, but concurrent publishers are ordinary: `glissa pack build` while the server runs, a second Glissa sharing `~/.glissa/packs/built`, and `npm test` backends (see M6). Process B deletes A's tmp mid-write; A rotates then ENOENTs, landing in M1. The `pairings-store.js` O_EXCL lockfile pattern would close it.

### M3 [MAJOR] Two skill dirs sharing a basename silently overwrite each other
`pack-core.js:415-419` keys skill outputs on basename. Probe-confirmed: build reports ok, delivered file holds only the second skill, `manifest.outputs` lists the same relPath twice with two sha256 values, one matching nothing on disk. Version stays deterministic so no staleness check ever sees it. Should be a build error like a no-match source.

### M4 [MINOR] `**`-prefixed source patterns always match zero files
`pack-builder.js:37-41,128-135`: a `**`-leading pattern yields empty root, `walkFiles('')` throws ENOENT, candidate list empty, build fails "matched no files" despite matching files existing. `packWatchRoots` (:107-114) also drops the root. Documented form is dead in walk and watch.

### M5 [MINOR] Publish IO errors escape `buildPacks` despite its never-throws docstring
`pack-builder.js:344-348 vs :351`: `publishBuild` sits outside the try. One pack's publish error aborts remaining specs in a `glissa pack build` run and the error names no pack. Service catches it; CLI exits 1.

### M6 [MINOR] Most backend-booting tests start the real pack service
Only 4 test files set `packsAutoRebuild: false`; roughly 14 others boot with it on, installing watchers on the checkout's real `packs/` and publishing into the operator's real `~/.glissa/packs/built` (installed pack's builtAt matches a test run). Also makes M2 reproducible via `npm test` beside a live server.

### M7 [MINOR] `pack-updated` landing mid-spawn loses its notice
`backend.js:1070` vs `sessions.js:2276-2296`: `_resolvePacks` clears delivered packs then awaits per pack; a broadcast in that window finds no delivered entry, `notePackUpdate` returns false, no notice armed. Dashboard chip still shows stale, so surfaces disagree. Small window, self-heals on next publish.

### M8 [MINOR] One throwing spec can leave the process with no sweep timer
`pack-service.js:85,108-122`: `watchRootsForSpec` outside the try; `start()` installs the interval only after the first sweep resolves. A rejection reaches backend.js:1422's catch and the fallback loop never arms for process life. Unlikely with current inputs.

### M9 [MINOR, low-confidence] Distiller deny-list may forbid the one write the lane exists for
`pack-distiller.js:54-56`: bare `Edit(*)`/`Write(*)` in `PACK_DISTILL_DENY`; if CC's matcher treats slash-less patterns as any-depth, every write is denied and each run ends "DISTILLED but output file missing". Tests only assert string presence. Needs one real distill run to confirm.

### Mill contract checks
Holding: deterministic builds, version hashes all delivered files excluding manifest; budget hard gates incl index cap; plan failure writes nothing; unchanged version publishes nothing; in-process rebuild serialization; `pack-updated` absent from replay retention; notice Glissa-authored, 600-char cap, consumed on read, re-armed only by newer version; injection only on accepted 200 UserPromptSubmit; unresolvable pack never blocks spawn; read-telemetry matcher only for pack-carrying sessions.
Qualified/failing: "failed build leaves last good current/ untouched" fails for publish-time IO errors (test covers plan-stage only); serialization is single-process; symlink skip does not always catch Windows junctions (loop-safe via realpath set); AGENTS.md does not mention the `optional: true` no-match exemption (pack-core.js:339-344).

### Mill recent-commit risks
- `6be6370` (repo-wide dedup): pack-scope moves checked line by line (isPlainObject, shortVersion with `'-'` fallback, validateOptionalArray), semantics identical, removed exports have no importers. Clean.
- Design note: every install/worktree publishes into the same `~/.glissa/packs/built/<name>` from its own sources; two servers on different branches would flip-flop publishes and arm notices on live sessions. Not occurring today (versions identical).

## Verdict (pass 1)

17 issues total.
- Visions: 1 critical (V1 shim injection), 2 major (V2 argv size, V3 write boundary low-confidence), 6 minor. Root cause common to V1/V2/V3: mirrored buffer reaches the spawn boundary with no cap, no escaping, no write containment.
- Context mill: 3 major (M1 non-atomic publish, M2 cross-process tmp deletion, M3 skill-name collision), 6 minor (one low-confidence).

Priority order suggestion: V1 (security, opt-in but real), M1+M2 (data-loss pair, one design fix covers both), V2, M3, then the rest.
