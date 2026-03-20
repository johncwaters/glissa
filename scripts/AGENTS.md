<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 -->

# scripts/ — Automation Scripts

## Purpose

Contains release and automation scripts for the Glissa project. These are developer tools, not included in the npm package.

## Key Files

| File | Description |
|------|-------------|
| `release.js` | End-to-end release script: verifies npm auth, checks clean tree, checks tag uniqueness, builds, publishes to npm, pushes to GitHub, creates git tag, creates GitHub release from CHANGELOG.md (requires `gh` CLI) |

## For AI Agents

### Working In This Directory

- Scripts are CommonJS (`require`), matching the server-side convention
- `release.js` reads `../package.json` for version and `../CHANGELOG.md` for release notes
- The release script exits early on any failure (dirty tree, existing tag, npm auth issues)
- GitHub release creation is optional — skipped if `gh` CLI is not installed

### Testing Requirements

Test by dry-running individual steps. Do not run `node scripts/release.js` without intent to publish.

## Dependencies

### Internal
- `../package.json` — Version number
- `../CHANGELOG.md` — Release notes extraction

### External
- `npm` CLI — Publishing
- `git` CLI — Tagging and pushing
- `gh` CLI (optional) — GitHub release creation

<!-- MANUAL: -->
