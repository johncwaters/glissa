<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# bin

## Purpose
The globally-installed CLI entry point for Glissa (`npm i -g github:johncwaters/glissa`; there is no registry package, see `../docs/distribution.md`). Parses CLI flags and boots the production server.

## Key Files

| File | Description |
|------|-------------|
| `glissa.ts` | `#!/usr/bin/env node` launcher: `doctor`, `pair` (`--list`, `--revoke <id>`, `--name <label>`), `pack` (`build [name]`, `list`), `--port`, `--config`, `--version`, `--help`; sets env vars, dispatches CLI-only commands, then imports `../server/main.ts` |
| `path-doctor.ts` | Pure PATH helpers shared by `glissa doctor` and the post-install PATH notice |

## For AI Agents

### Working In This Directory
- Keep this a thin argv parser; real logic belongs in `server/backend.ts` or `server/config-store.ts`.
- `package.json` `bin` points at the BUILT CLI under `dist/`, so a new local import rides the bundle and needs no `files` entry; the packaged-install job in `.github/workflows/test.yml` is still the gate.

### Testing Requirements
- `npm test` for behavior; the packaged-install CI job proves the installed CLI runs from `dist/`.

## Dependencies

### Internal
- `../server/main.ts` / `../server/backend.ts` - the server it boots
- `../server/config-store.ts` - config resolution

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
