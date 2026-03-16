<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-15 -->

# docs/ — Documentation

## Purpose

Guides for publishing Glissa to npm and testing the CLI. These are developer-facing documents, not included in the npm package.

## Key Files

| File | Description |
|------|-------------|
| `publishing.md` | Step-by-step npm publishing guide — account setup, name availability, first publish, version bumping, node-pty native dependency notes, troubleshooting |
| `testing-cli.md` | Manual CLI test scenarios — all flags (`--help`, `--version`, `--port`, `--config`), config resolution order, auto-seeding, `npm pack` verification, `npm link` testing |
| `glissa-plan.md` | Original project planning document — architecture decisions, feature scope, implementation roadmap |

## For AI Agents

### Working In This Directory

These are reference documents. Update them when CLI behavior changes (new flags, config resolution changes, new dependencies).

### Testing Requirements

No tests — these are documentation files.

## Dependencies

### Internal
References `bin/glissa.js`, `config-store.js`, `server.js`, `package.json`.

<!-- MANUAL: -->
