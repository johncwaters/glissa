<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-10 | Updated: 2026-03-11 -->

# Spike Directory — Agent Guide

**Status:** Archive (throwaway exploration)

## Overview

The `spike/` directory contains throwaway exploration and spike scripts used during early development to validate technical assumptions about the Claude CLI, node-pty behavior, and interactive terminal features.

**Do not refactor, clean up, or add tests here.** These scripts are historical documentation of the investigation process that led to Glissa's core architecture.

## Foundational Finding

**Claude CLI produces ZERO output when spawned with piped (non-TTY) stdio.**

This single finding justified the entire technical design: Glissa requires `node-pty` to spawn a real pseudo-terminal instead of using Node's standard `child_process.spawn()`. Without it, the Claude CLI hangs silently—no output, no error, no graceful failure.

## File Catalog

### Primary Investigation Scripts

| File | Purpose | Key Finding |
|------|---------|------------|
| `test-piped-stdio.js` | Spawn `claude -p` with piped stdio (`stdio: ['pipe', 'pipe', 'pipe']`). Observe chunk timing and ANSI behavior. | **Claude produces zero stdout/stderr with piped stdio.** Process hangs and must be killed. |
| `test-interactive.js` | Spawn `claude` (no args) with piped stdio in interactive mode. | **Same result:** zero output. PTY is required for any interactivity. |
| `test-interactive2.js` | Variant on interactive PTY test. | Refinement iteration. |
| `test-interactive3.js` | Further PTY interaction refinements. | Iteration. |
| `test-interactive4.js` | Final interactive PTY test variant. | Iteration. |
| `test-json-output.js` | Test `claude -p --output-format json`. | JSON output still requires piped stdio; same zero-output issue. |
| `test-stream-json.js` | Test `claude -p --output-format stream-json`. | Requires `--verbose` flag; piped stdio still produces no output without PTY. |
| `test-permissions.js` | Test Claude CLI permission prompt behavior when spawned with different stdio modes. | Prompts do not appear in piped mode; PTY required for interactive prompts. |

### Test Runners

| File | Purpose |
|------|---------|
| `run-all-tests.js` | Execute all spike tests in sequence, capture output. |
| `run-remaining-tests.js` | Execute subset of spike tests. |

### Test Output

| File | Description |
|------|-------------|
| `results.txt` | Captured output from comprehensive spike test run showing piped stdio behavior. |
| `results2.txt` | Additional test output. |
| `interactive-results.txt` | Output from interactive PTY tests. |
| `interactive-results2.txt` | Additional interactive test output. |

## Key Technical Insights

### Why Not child_process.spawn()?

Early testing used `spawn('claude', [...], { stdio: ['pipe', 'pipe', 'pipe'] })` from Node's built-in `child_process`. Result: **complete silence**. The Claude CLI does not write to piped stdout/stderr at all when run outside a TTY.

**Evidence from `results.txt`:**
```
TEST: (a) Piped stdio with -p
ARGS: claude -p what is 2+2? reply with just the number
[TIMEOUT after 30000ms - killing]
[stdout] elapsed=43751ms size=174 hasAnsi=false
[exit] code=null elapsed=45629ms killed=true
[summary] stdout_chunks=1 stderr_chunks=0
```

The process only produced output after 43+ seconds of timeout, and only when forcibly killed—a symptom of the process hanging without a TTY.

### Why node-pty Works

`node-pty` allocates a real pseudo-terminal (PTY) for the spawned process. When Claude CLI runs with `tty: true` (via PTY), it detects interactive mode and produces output normally. This is the **only way** to capture Claude output.

### Environment Cleanup

Before spawning, clean these env vars to avoid nesting detection:
- `CLAUDECODE`
- `CLAUDE_CODE_SSE_PORT`
- `CLAUDE_CODE_ENTRYPOINT`

(See `test-interactive.js` line 4–7 for pattern.)

### ANSI and Chunk Behavior

When Claude CLI runs in a real PTY, it produces ANSI escape codes for styling and color. The spike tests confirmed:
- Piped (non-PTY) mode: zero ANSI codes, zero output
- PTY mode: full ANSI support, chunked streaming behavior
- Chunk timing varies; do not assume single-chunk responses

### JSON Output Mode

`--output-format json` or `--output-format stream-json` do not circumvent the piped stdio problem:
- JSON mode still hangs with piped stdio unless run in a PTY
- `stream-json` requires `--verbose` flag and still needs PTY
- PTY is non-negotiable

## Architecture Implications

These findings led directly to Glissa's dual-WebSocket architecture:

1. **Data WebSocket** (`/terminals/:sessionName`) carries raw PTY bytes bidirectional
   - Node spawns Claude via `node-pty` → `pty.spawn()`
   - PTY output piped to WebSocket → browser xterm.js

2. **Control WebSocket** (`/control`) carries JSON state-change commands
   - Clean separation: PTY is a dumb pipe, control is structured data
   - Allows independent test runners (`run-all-tests.js`, etc.) without WebSocket overhead

3. **No Alternative Paths**
   - Do NOT attempt to use `child_process.spawn()` with piped stdio
   - Do NOT try to parse Claude CLI output formats as a workaround
   - Do NOT use polling or timeout-based detection—the process hangs silently

## For AI Agents

### When to Reference This Directory

- **Understanding WHY node-pty was chosen:** Read `test-piped-stdio.js` and `results.txt`
- **Understanding claude CLI behavior:** Read `test-json-output.js`, `test-permissions.js`
- **Understanding TTY requirements:** Read any of the interactive test files
- **Understanding environment setup:** See env cleanup pattern in `test-interactive.js`

### What NOT to Do Here

- Do not refactor these files (they're historical)
- Do not add new tests (this is not a test suite)
- Do not change the findings (they're validated via test output)
- Do not attempt to circumvent PTY requirement (it won't work)

### Key Code Patterns to Reuse

**Environment cleanup before spawn:**
```javascript
const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
delete cleanEnv.CLAUDE_CODE_SSE_PORT;
delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
```

**PTY spawn (use node-pty, not child_process):**
```javascript
const pty = require('node-pty');
const proc = pty.spawn('claude', args, {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  env: cleanEnv
});
```

## References

- **Parent:** `../AGENTS.md` — Main project architecture guide
- **Implementation:** `../sessions.js` — Live PTY management using these patterns
- **Production entry:** `../server.js` — Express + WebSocket server using node-pty sessions
