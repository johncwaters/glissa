# Deletion plan: navigator lane

Scope: `server/navigator-*`, `server/core/navigator-*`, `session/navigator-relay.js`, the Navigator
tab's own halves of `public/navigator-panel.js` / `public/navigator-view-core.mjs`, their tests, and
the minimal `backend.js` / `control-handlers.js` call sites.

## Verdict on the whole lane

The lane is the weakest line-per-value feature in the repo: roughly 1900 server lines, 720 frontend
lines, a 53-line VS Code extension and 3300 test lines, for a feature that is config-file-only opt-in,
needs a hand-written LSP client entry in the operator's editor, and whose always-on output duplicates
marksman and ltex-ls. Deleting it outright is the defensible call and is flagged for the operator.

Not doing that here, per scope: the tier 3 dispatch (an ephemeral `claude -p` reading the buffer at a
pause and answering with comment cards) is the one thing off-the-shelf LSP servers do not do, and the
tier 2 sweep is cheap and is what makes the editor integration two-way. Those two stay; everything
built on top of them goes.

## Dies

1. **The intent model (M5), whole feature.** `server/core/navigator-intent-core.js`, the wiring's
   intent state / merge / broadcast / snapshot field, the `navigator-set-intent` control handler, the
   result file's optional `intent` field, the prompt's working-intent block, the tab's intent block
   (statement, source-and-age line, correction field, adoption rules), and 4 test files' worth of
   coverage. One machine-wide sentence, in memory only, reset by every daemon restart, carrying
   lock/merge/staleness/adoption machinery and a control-WS write path, to seed one optional line of
   one prompt. The dispatch already carries the buffer it is commenting on.
2. **The activity budget ladder inside the dispatch gate.** `activityMaxPerHour`, `classifyTrigger`,
   `armedBy` plumbing, per-trigger dispatch counting, `nonNegativeInt`, and the trigger-keyed refusal
   log dedupe. A second budget carved out of a six-per-hour total, plus a tie-break rule for cold
   buffers, to rank machine-armed dispatches below edit-armed ones. One cap decides the same thing.
   KEPT: `noteActivity()` and the `contextSeq` movement gate themselves, unchanged in contract, so the
   ingest lane's poke still arms a quiet window (coordinated with the ingest pass, which kept its side).
3. **Incremental LSP sync.** The relay advertised `change: 2`, so `navigator-buffer-core.js` carried a
   line/character-to-offset walker with CRLF handling and range splicing. The wiring re-sweeps the
   whole document on every applied change anyway, so the offsets bought nothing but edge cases. The
   relay now advertises full sync and the store takes whole-text frames.
4. **Malformed-header resync in the LSP framer.** `resyncAfterBadHeader`, `isHeaderBoundary`,
   `headerSuffixStart`: three functions scanning for a partial `content-length:` suffix to recover a
   stream produced by the editor's own LSP client, which does not emit headerless frames. A bad header
   now drops the buffered bytes.
5. **`findingsSnapshot()`**, superseded by `documentsSnapshot()` and read only by tests.

## Folds

- `contentMarker`/`bufferMarker`/`activityMarker` collapse to one marker builder.
- `decideDispatch` / `recordDispatch` lose their `trigger` return and argument.
- The refusal log dedupes on the gate alone.

## Kept, and why

- Tier 2 markdown sweep (`navigator-rules-core.js`, 133 lines): the only zero-cost, zero-latency
  output, and the pause boundary that arms tier 3.
- Tier 3 dispatch and its security posture: constructed only behind `config.navigator.dispatch.enabled`,
  narrow allow (`--allowedTools=Write`) and never skip-permissions, buffer fenced as DATA, throwaway
  cwd, hard timeout, result file never free text.
- The relay's reconnect + didOpen replay (the Vite-restart case it exists for).
- The ingest digest section in the prompt and the `noteActivity` poke (cross-lane, coordinated).

## Expected delta

Roughly -1050 source lines and -1450 test lines.

## Flaky test

`tests/navigator-dispatch.test.js` awaits `new Promise(resolve => setTimeout(resolve, 0).unref())`
twice. An unref'd timer that is the only work left lets the loop resolve with the promise pending, so
node cancels the remaining tests ("cancelledByParent"). Reproduced: 3 cancelled every run. The waits
stop unref'ing.
