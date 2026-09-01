<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# scripts

## Purpose
Maintainer scripts for cutting a release and validating the install tarball. Glissa is not published to a registry: distribution is the GitHub repo, provisioned by `claude-setup` on servers and by `npm i -g github:johncwaters/glissa` for a standalone CLI (see `../docs/distribution.md`).

## Key Files

| File | Description |
|------|-------------|
| `release.ts` | Release pipeline: pushes to GitHub, tags, creates the GitHub release. No registry publish. Run as `node scripts/release.ts` |
| `memory-purge-fixtures.ts` | Removes test-fixture records from a memory database (`node scripts/memory-purge-fixtures.ts <db-path> [--dry-run]`), backing it up first and expunging through the store's own three writes |
| `prepare-build.js`, `postinstall-path-check.js` | Stay plain `.js`: npm runs them INSIDE `node_modules` on a git install, where Node refuses type stripping |

## For AI Agents

### Working In This Directory
- After adding a server module that ships, check `package.json` `files`; a miss means a broken `npm i -g github:johncwaters/glissa`, which the packaged-install job in `.github/workflows/test.yml` catches.
- These are one-shot cold paths: sync `execSync`/fs is acceptable here (unlike server runtime paths).

### Testing Requirements
- Run the script itself; no unit tests.

## Dependencies

### Internal
- `../package.json` - the `files` whitelist and entry points they validate before a release

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
