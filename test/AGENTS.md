<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# test

## Purpose
Manual smoke tests and harnesses run directly with `node`, separate from the automated `tests/` suite (which `npm test` runs).

## Key Files

| File | Description |
|------|-------------|
| `smoke-dormant-boot.ts` | Boots the backend in-process, verifies dormant-by-default boot and the start-session control flow |
| `probe-codex-session.ts` | Live verification of the Codex adapter against a real `codex` binary: boots the backend on a throwaway config and drives one supervised session through spawn, working, awaiting-input, approval, complete and resume. Costs one real codex turn; leaves a recording the replay fixtures are cut from |
| `ablation/run-pairs.ts` | Paired ON/OFF context-pack ablation over real billed Claude sessions; appends one JSONL record per pair and scores them with the pure `ablation/ablation-core.ts` |
| `browser/harness.ts` | Headless-Chromium dashboard matrix: boots Vite plus the backend on a throwaway config, substitutes a fake agent via a PATH shim, drives every viewport through scripted steps, and writes screenshots, diffs and a report an agent can read. Linux and macOS only, since the shim is a POSIX `sh` script: it exits 2 on Windows |
| `browser/fake-agent.ts` | Deterministic TUI stand-in for `claude`: paints a ruler frame that is a pure function of `(cols, rows, tick)`, so a browser assertion is a two-way fixpoint against the negotiated grid rather than a screenshot diff |
| `support/backend-harness.ts` | In-process backend scaffolding shared by the probes here: listen, free high port, control socket, throwaway Claude config, bounded shutdown |
| `container/Dockerfile` | node:24-bookworm image for the Linux-only remote-mode suite (`npm run test:container`) |
| `container/remote-mode.sh` | Remote-mode integration assertions: two listeners, pairing lifecycle, revocation, Origin policy |
| `container/ws-check.js` | WebSocket probe used by that script (cookie/Origin headers, waits for a control snapshot) |

## For AI Agents

### Working In This Directory
- New AUTOMATED tests go in `../tests/` (node:test). This directory is for run-by-hand smoke scripts only.
- A hand-run harness may keep its pure decision logic in a sibling module (`ablation/ablation-core.ts`); that module's unit test still belongs in `../tests/` and requires across, so the logic is pinned by `npm test` while the billed harness around it stays hand-run.
- Smoke scripts must shut down cleanly (in-process server, no orphan listeners).

### Testing Requirements
- Run directly: `node test/smoke-dormant-boot.ts`.
- Run the browser matrix: `npm run test:browser` (`--only <scenario>`, `--viewport <name>`, `--artifacts <dir>`, `--prove-failure`, `--headed`, `--executable <path>`).
- `--prove-failure` adds the self-check case whose failure IS the proof, so it never sets the exit code: 0 when every other case passed and the proof bit, 1 when another case failed, 2 when the proof did not bite.

## Dependencies

### Internal
- `server/backend.ts`, `session/sessions.ts`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
