<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# detection

## Purpose
Status detection and change watching. Session status is derived from machine-emitted structural signals: authoritative Claude Code HTTP hooks plus an OSC-0 title fallback, merged with precedence and conflict handling. Also home to the event-driven git watchers that power the worktree review gate. NO screen scraping anywhere.

## Key Files

| File | Description |
|------|-------------|
| `status-source.js` | Merges hook + title signals: precedence hook > title, `ready` conflict window so a racing `awaiting-input` wins, dedup |
| `hook-source.js` | `HookRouter`: validates the per-session bearer token, maps Claude Code hook POSTs (`Stop`, `Notification`, `UserPromptSubmit`, `SessionStart/End`, `SubagentStart/Stop`, post-tool wakeups) to signals |
| `settings-injector.js` | Writes the per-session `--settings` file injecting HTTP hooks that POST to `POST /hook/:glissaId/:event` (token in URL) |
| `osc-title-source.js` | OSC-0 title fallback: braille or circle-halves spinner = `working`, idle glyph = `ready`, unknown glyph = `unknown` (never a guess, never `awaiting-input`) |
| `replay.js` | Version-aware replay harness: drives `session-recorder.js` JSONL recordings (v1/v2) through the detection stack |
| `worktree-watch.js` | fs.watch on the per-worktree gitdir; nudges `sessions.js` to recompute the diff when git state moves. Watch-only, no parsing |
| `integration-ref-watch.js` | Reflog-based listener for integration-branch movement (e.g. another session merged into develop) that no local worktree event would surface |
| `watch-debounce.js` | Shared debounce-into-trailing-call + stop lifecycle used by `worktree-watch.js` and `integration-ref-watch.js` (both single-directory fs.watch listeners) |

## For AI Agents

### Working In This Directory
- The PTY data path does NO content parsing beyond scanning for OSC-0 titles. Do not reintroduce body/line scraping.
- Hook signals are authoritative; the title source is fallback only and must never emit `awaiting-input`.
- Keep the bearer-token check in `hook-source.js`; it is the trust boundary of the only HTTP write ingress.
- Watchers are listeners, not pollers: they say "look again", `sessions.js` recomputes the truth. Keep recompute work async (shared event loop).
- The signal x state transition matrix lives in `session/core/status-mapper.js` and is documented in `docs/postmortem-terminal-detection.md`.

### Testing Requirements
- Unit tests: `tests/status-source.test.js`, `hook-source.test.js`, `osc-title-source.test.js`, `worktree-watch.test.js`, `integration-ref-watch.test.js`.
- Detection behavior changes must keep `tests/replay-harness.test.js` green against the `tests/fixtures/*.jsonl` recordings; add a fixture for a new signal scenario.

### Common Patterns
- Sources emit normalized signals; `sessions.js._onStatus` + `session/core/status-mapper.js` decide transitions.
- Injected dependencies (watcher factory, session map, recheck fn) so modules unit-test without a real fs or backend.

## Dependencies

### Internal
- `../sessions.js` - consumes StatusSource, owns transitions
- `../session-recorder.js` - produces the JSONL that `replay.js` consumes
- `../session/core/status-mapper.js` - the pure signal-to-event decision

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
