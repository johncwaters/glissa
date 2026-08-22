# Deletion plan: context packs (the context mill)

The core feature is one sentence: assemble local sources into a versioned, budgeted directory and hand
it to a spawn with `--add-dir`. Everything below accreted around that sentence. Four satellites are
deleted whole; the assembly path, the atomic publish, determinism, the budget gates and the walker's
symlink skip are untouched.

## Deleted features

| Feature | Files / wiring | Why it dies |
|---|---|---|
| **Distiller lane** | `server/pack-distiller.js`, `server/core/distill-core.js`, `tests/pack-distiller.test.js`, `tests/distill-core.test.js`, spec key `distill` + its validation, `distillOutputPath` / `distillSourceHashes` / `isPackRelativePath` / the `keepFullPath` reader flag, `glissa pack distill`, `config.packDistiller`, the `PACK_DISTILL_DENY` list, the generated `packs/sources/glissa/derived/architecture-brief.md` | ~1300 lines, opt-in and off by default, to spawn an LLM that rewrites the mill's own inputs. The mill's whole claim is determinism from files on disk; a model in the input path is the opposite bet, and a carbon unit writing that brief by hand costs one file, not a lane with a deny-list, a stamp format, a result-file contract and a post-verify. |
| **Live staleness notice** | `session/core/pack-notice.js`, `tests/pack-notice.test.js`, `tests/session-pack-notice.test.js`, `tests/backend-pack-notice-hook.test.js`, `Session.notePackUpdate` / `takePackNoticeContext` / `_clearPackNotice`, the `hookSpecificOutput` branch on the hook route | ~470 lines to inject one advisory sentence into a turn. It also made the hook RESPONSE a second injection ingress that needed its own Glissa-authored-only rule, a char cap and a truncation tail. Deleting it restores the hook reply to the plain `{ok,reason}` body and removes the ingress rather than guarding it. The answer to a rebuilt pack was always "restart the session". |
| **Pack read telemetry** | `session/core/pack-read-tracker.js`, `tests/pack-read-tracker.test.js`, `tests/session-pack-reads.test.js`, `Session._trackPackRead` / `packReadSummary` / `_packReads`, the `Read` PostToolUse matcher in `detection/settings-injector.js`, the `pack-read` signal in `detection/hook-source.js`, the recorder footer's `packReads`, `config.packReadTelemetry`, the `reads` snapshot field, `readCountText` / `sinceNoticeCount` | ~600 lines and a per-Read hook callback to produce a number nothing acts on. It answered "did the agent open what it was handed", then required a recorder quiet-rule to stop the answer from burying the records a recording exists for. With the notice channel gone, `readsSinceNotice` measures a channel that no longer exists. |
| **Staleness chip + version fan-out** | `public/session-card/pack-stale-core.mjs`, `tests/frontend-pack-stale.test.js`, `tests/control-pack-versions.test.js`, the `pack-updated` and `session-packs` broadcasts, `snapshot.packVersions` + `getPackVersions`, `pack-service`'s `versionsByName` / `getVersions` / `pack-updated` emit, `setLatestPackVersions` / `notePackVersion` / `applyPackStaleness` / `packReadsText` in `lifecycle.js`, the `.pack-badge` element and CSS | ~250 lines across nine files for an advisory chip whose only action is a restart the operator who edited the source already knows about. It is the last consumer of the version fan-out, so the whole "who is running an old version" pipeline goes with it: two control-WS message types, one snapshot field and one cross-session version map. |

## What folds

- `pack-service.js` keeps both loops (watchers for latency, sweep for correctness) but loses the
  version map, the getter and the emit: a rebuild now just logs.
- `pack-core.js` loses `DISTILL_KEYS`, `validateDistillEntry`, `isPackRelativePath`, the `optional`
  source flag (it existed only for a derived file the distiller had not written yet), and the exports
  nothing imported any more (`CHARS_PER_TOKEN`, `estimateTokens`, `sha256`, `sourceSlug`).
- `pack-builder.js` loses the two distill helpers and the `keepFullPath` branch in the source reader.
- The debug overlay gains one line naming the delivered packs and versions, so `snapshot.packs`
  (now `{ name, version }`) keeps a reader after the chip's removal.

## What stays, deliberately

Atomic publish (tmp sibling, rotate `current` to `previous`, rename in); determinism (version is the
hash of every delivered file); the hard budget gates (per pack plus the tighter index cap); the
match-nothing source error; the walker's symlink and `.git`/`node_modules` skip plus its realpath loop
guard; `normalizePackNames` (config.json is the hand-edited interface, so a bad entry must cost that
entry and not the spawn); `--add-dir` delivery with the `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`
flag; the pack decision-trace entries; `glissa pack build` / `pack list`; auto-rebuild behind
`config.packsAutoRebuild`.

## Expected delta

Roughly -2700 lines deleted against ~+40 added, net about -2650. Two config keys
(`packDistiller`, `packReadTelemetry`), one CLI subcommand, two control-WS message types and one
snapshot field disappear.
