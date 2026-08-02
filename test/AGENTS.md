<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# test

## Purpose
Manual smoke tests and harnesses run directly with `node`, separate from the automated `tests/` suite (which `npm test` runs).

## Key Files

| File | Description |
|------|-------------|
| `smoke-dormant-boot.js` | Boots the backend in-process, verifies dormant-by-default boot and the start-session control flow |

## For AI Agents

### Working In This Directory
- New AUTOMATED tests go in `../tests/` (node:test). This directory is for run-by-hand smoke scripts only.
- Smoke scripts must shut down cleanly (in-process server, no orphan listeners).

### Testing Requirements
- Run directly: `node test/smoke-dormant-boot.js`.

## Dependencies

### Internal
- `../backend.js`, `../sessions.js`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
