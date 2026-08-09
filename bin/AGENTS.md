<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# bin

## Purpose
The globally-installed CLI entry point for Glissa (`npm i -g github:johncwaters/glissa`; there is no registry package, see `../docs/distribution.md`). Parses CLI flags and boots the production server.

## Key Files

| File | Description |
|------|-------------|
| `glissa.js` | `#!/usr/bin/env node` launcher: `--port`, `--config` (default `~/.glissa/config.json`), `--version`, `--help`; sets `GLISSA_PORT`/`GLISSA_CONFIG` env vars then `require('../server')` |

## For AI Agents

### Working In This Directory
- Keep this a thin argv parser; real logic belongs in `backend.js` or `config-store.js`.
- It is listed in `package.json` `bin`, so every local file it requires must be in the `files` whitelist that bounds the GitHub-spec install tarball (`scripts/check-package-files.js` enforces this).

### Testing Requirements
- `node scripts/check-package-files.js` after changing requires; `npm test` for behavior.

## Dependencies

### Internal
- `../server.js` / `../backend.js` - the server it boots
- `../config-store.js` - config resolution

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
