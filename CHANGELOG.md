# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **Guided onboarding tutorial**: Removed the first-install welcome tour (guide engine, tooltip component, and all related CSS/state).

## [0.6.0] - 2026-03-28

### Added

- **Skip-permissions visual indicator**: Session cards show a shield icon when `dangerouslySkipPermissions` is enabled, with redesigned card header layout.
- **Stable UUID session keys**: Sessions are now keyed by a stable UUID (`id`) instead of mutable display name. Includes inline rename support and skip-permissions toggle per session.

### Fixed

- Suppress false "needs input" notification during typing pause.
- Trigger tutorial and clear empty placeholder on first-time setup.

### Docs

- Document trust boundary, session identity, and skip-permissions security model.

## [0.5.2] - 2026-03-26

### Added

- Pre-publish validation script for package.json `files` array.

### Changed

- Bumped version for npm publish.

## [0.5.1] - 2026-03-26

### Fixed

- Include `ansi-tokenizer.js` and `line-assembler.js` in npm package files.
- Resolve doubled paste output and add Ctrl+Backspace word delete.

### Docs

- Update AGENTS.md with new modules and remove stale references.

## [0.5.0] - 2026-03-24

### Added

- **Split layout mode**: Two side-by-side full-height terminals for focused parallel work.
- **Trust prompt detection**: Detect "Enter to confirm" trust prompts as needs-input events.

### Changed

- **ANSI processing pipeline**: Replace `stripAnsi` with a proper ANSI tokenizer + line assembler pipeline for more robust pattern detection.

### Fixed

- Prevent OSC sequences from cancelling armed prompt matches.
- Minimized tab sizing and Layer 4 idle prompt false positives.

## [0.4.0] - 2026-03-21

### Added

- **NotificationManager**: Centralized notification system with state machine (IDLE→PENDING→DELIVERED→ESCALATED) replacing inline `notify()` calls in sessions.js.
- **Channel architecture**: Pluggable notification channels via adapter pattern (`channels/toast.js` for BurntToast/msg fallback). Future channels (Slack, email) can be added without touching core logic.
- **Input grace period**: Suppress false "needs input" prompt detections for a configurable window after user input (`inputGraceSeconds`, default 5s).
- **Layer 3 pattern filters**: Reduce false positive prompt detections — skip short fragments, trailing URL schemes (`://`), and indented short menu items.
- `rearmSilenceTimer()` on PatternDetector for retrying detection after grace period rejection without clearing pending line state.

### Changed

- Notification lifecycle (debounce, escalation, suppression) is now managed by NotificationManager in backend.js instead of being scattered across sessions.js and notify.js.
- Biome lint scope expanded from `public/**` to `**` with exclusions for `dist/`, `node_modules/`, ESM files, and Vite config.
- Disabled `noRedundantUseStrict` (CJS uses `'use strict'` intentionally) and `noControlCharactersInRegex` (ANSI stripping requires control chars) in biome.json.
- Applied biome lint fixes: `&&` guard → optional chaining, `let` → `const` where appropriate, unused params prefixed with `_`.
- `configStore.getSettings()` now exposes `inputGraceSeconds` and `notifyDebounceMs`.

### Fixed

- Escalation ping-pong no longer re-records category debounce, which could suppress notifications for other sessions.

### Deprecated

- `notify.js` — functions are now no-ops with one-time deprecation warnings. Use NotificationManager instead.

### Removed

- Unused imports in control-handlers.js (`makeSession`, `wireSessionEvents`, `closeSessionDataClients`).
- `_escalationTimer` and `_destroying` flag from Session class (responsibility moved to NotificationManager).

## [0.3.0] - 2026-03-19

_Skipped in changelog — incremental fixes and version bump._

## [0.2.0] - 2026-03-17

### Added

- **Maximize mode**: Click the Maximize button to expand a terminal full-screen while all others collapse to the minimized bar. Click any minimized session to switch. Press ESC or click Restore to return to grid view.
- **COMPLETE state**: When an agent works for 30+ seconds and goes quiet, the session shows a green "Complete" badge and triggers a Windows toast notification. Clicking the terminal dismisses it back to Idle.
- **Notification debouncing**: Deduplicate toast notifications per category (waiting, failed, complete) within a configurable window.
- Suppress Windows toast notifications when the dashboard browser window is focused.

### Changed

- Rename "Running" badge to "Working" — reflects active agent output.
- Rename "Done" badge to "Exited" — reserved for process exit; "Complete" now indicates finished tasks.
- Reduce default idle timeout from 60s to 5s — terminals return to Idle quickly when output stops.
- Minimized tabs are fixed-width (240px) with truncated names and right-aligned status badges.
- Minimized sessions show an up arrow (▲) instead of right arrow to indicate they can be restored.
- Hide Restart and Remove buttons when a session is minimized.
- Debounce focus-state reporting (150ms) to prevent spurious notifications during DOM operations.
- Extract `_buildSpawnEnv`, `_handlePtyData`, `_handlePtyExit` from `Session.start()` to reduce method length.
- Extract `_forceKillAfterTimeout` from `Session.kill()` with named constants.
- Add `DATA_HANDLERS` table for state-driven PTY data dispatch, replacing if-else chain.
- Extract helpers from `applyConfigReload()` in backend.js and `applyState()` in session-card.js.
- Replace `getSessionUIs()` exposure with encapsulated helpers.
- Use PowerShell `Get-Module -ListAvailable` for BurntToast discovery with path-scanning fallback.

### Fixed

- Resolve SonarLint and Biome lint issues across frontend (sorted imports, optional chaining, nested ternaries, negated conditions).

### Removed

- Focus mode (CSS-only) — replaced by maximize mode which uses real minimization.
- Dead code: `user_input`/`user_skip` transitions and guards in sessions.js.
- Dead exports from theme.js, local-store.js, config-store.js.

## [0.1.0] - 2026-03-15

### Added

- Initial release
- Spawn and manage multiple Claude Code sessions via browser dashboard
- Real-time terminal output with xterm.js and WebGL acceleration
- Dual WebSocket architecture (control channel + per-session PTY streaming)
- 7-state session lifecycle (INITIALIZING, STARTING, RUNNING, WAITING, IDLE, DONE, FAILED)
- 3-layer prompt detection (exact match, regex, silence heuristic)
- Windows toast notifications via BurntToast PowerShell module
- Drag-and-drop session reordering with persistence
- Configurable themes (Golgari, Midnight, Phyrexian, Compleated)
- Hot-reloadable configuration with auto-seeding to `~/.glissa/config.json`
- Guided onboarding tutorial for first-time users
- Alert sounds for session attention events
- CLI with `--port`, `--config`, `--help`, `--version` flags

[0.6.0]: https://github.com/johncwaters/glissa/releases/tag/v0.6.0
[0.5.2]: https://github.com/johncwaters/glissa/releases/tag/v0.5.2
[0.5.1]: https://github.com/johncwaters/glissa/releases/tag/v0.5.1
[0.5.0]: https://github.com/johncwaters/glissa/releases/tag/v0.5.0
[0.4.0]: https://github.com/johncwaters/glissa/releases/tag/v0.4.0
[0.3.0]: https://github.com/johncwaters/glissa/releases/tag/v0.3.0
[0.2.0]: https://github.com/johncwaters/glissa/releases/tag/v0.2.0
[0.1.0]: https://github.com/johncwaters/glissa/releases/tag/v0.1.0
