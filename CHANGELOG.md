# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Resolve SonarLint and Biome lint issues across frontend (sorted imports, optional chaining, nested ternaries, negated conditions)
- Add `biome.json` config and `public/package.json` for correct ES module detection

### Changed

- Extract `_buildSpawnEnv`, `_handlePtyData`, `_handlePtyExit` from `Session.start()` to reduce method length
- Extract `_forceKillAfterTimeout` from `Session.kill()` with named constants (`KILL_POLL_INTERVAL_MS`, `KILL_MAX_WAIT_MS`)
- Add `DATA_HANDLERS` table for state-driven PTY data dispatch, replacing if-else chain
- Extract `_removeOldSessions`, `_addNewSessions`, `_modifyChangedSessions` from `applyConfigReload()` in backend.js
- Extract `_handleEndedTransition`, `_handleRestartTransition` from `applyState()` in session-card.js
- Inline session action handlers into dispatch map in control-handlers.js
- Replace `getSessionUIs()` exposure with encapsulated helpers: `hasSession()`, `getSessionCount()`, `reconnectDataWs()`, `fitAllVisible()`
- Use PowerShell `Get-Module -ListAvailable` for BurntToast discovery with path-scanning fallback

### Removed

- Dead code: `user_input`/`user_skip` transitions and guards in sessions.js
- Dead exports: `getCurrentThemeId`, `getDefaultThemeId`, `THEMES` from theme.js
- Dead export: `removeKey` from local-store.js
- Dead export: `load` from config-store.js

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

[0.1.0]: https://github.com/johncwaters/glissa/releases/tag/v0.1.0
