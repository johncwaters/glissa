<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-15 -->

# bin/ — CLI Entry Point

## Purpose

Contains the CLI entry point for Glissa when installed globally via npm (`npm install -g glissa`) or run via `npx glissa`. Parses command-line arguments and bridges them to the server via environment variables.

## Key Files

| File | Description |
|------|-------------|
| `glissa.js` | CLI entry point with `#!/usr/bin/env node` shebang. Parses `--help`, `--version`, `--port`, `--config` flags. Bridges `--config` and `--port` to `GLISSA_CONFIG` and `GLISSA_PORT` env vars, then requires `../server` |

## For AI Agents

### Working In This Directory

- This is a thin arg-parsing layer — business logic lives in `server.js` and `backend.js`
- Flags are bridged to env vars (`GLISSA_CONFIG`, `GLISSA_PORT`) which `config-store.js` and `backend.js` read
- The `require('../server')` at the end triggers the full server startup
- Must maintain the `#!/usr/bin/env node` shebang for npm bin linking

### Testing Requirements

See `docs/testing-cli.md` for comprehensive CLI test scenarios covering all flags, config resolution, and edge cases.

### Common Patterns

```javascript
// Arg parsing: simple indexOf-based, no external parser
const portArg = getArgValue('--port');
if (portArg) process.env.GLISSA_PORT = portArg;
```

## Dependencies

### Internal
- `../server.js` — Production server entry point
- `../package.json` — For `--version` output

<!-- MANUAL: -->
