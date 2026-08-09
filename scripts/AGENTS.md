<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# scripts

## Purpose
Maintainer scripts for cutting a release and validating the install tarball. Glissa is not published to a registry: distribution is the GitHub repo, provisioned by `claude-setup` on servers and by `npm i -g github:johncwaters/glissa` for a standalone CLI (see `../docs/distribution.md`).

## Key Files

| File | Description |
|------|-------------|
| `release.js` | Release pipeline: pushes to GitHub, tags, creates the GitHub release. No registry publish. Run as `node scripts/release.js` |
| `check-package-files.js` | Traces string-literal `require()` calls from the package entry points (bin, main) and verifies every required file is in `package.json` `files`; dynamic requires are not detected |

## For AI Agents

### Working In This Directory
- After adding a server module that ships, run `node scripts/check-package-files.js`; a miss means a broken `npm i -g github:johncwaters/glissa` (npm packs the repo for a GitHub spec, so the `files` whitelist still bounds the tarball).
- These are one-shot cold paths: sync `execSync`/fs is acceptable here (unlike server runtime paths).

### Testing Requirements
- Run the script itself; no unit tests.

## Dependencies

### Internal
- `../package.json` - the `files` whitelist and entry points they validate before a release

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
