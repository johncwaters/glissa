<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# scripts

## Purpose
Maintainer scripts for releasing and validating the npm package. Not shipped to users.

## Key Files

| File | Description |
|------|-------------|
| `release.js` | Release pipeline: publishes to npm, pushes to GitHub, tags, creates the release. Run as `node scripts/release.js` |
| `check-package-files.js` | Traces string-literal `require()` calls from the package entry points (bin, main) and verifies every required file is in `package.json` `files`; dynamic requires are not detected |

## For AI Agents

### Working In This Directory
- After adding a server module that ships, run `node scripts/check-package-files.js`; a miss means a broken npm install.
- These are one-shot cold paths: sync `execSync`/fs is acceptable here (unlike server runtime paths).

### Testing Requirements
- Run the script itself; no unit tests.

## Dependencies

### Internal
- `../package.json` - the `files` whitelist and entry points they validate/publish

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
