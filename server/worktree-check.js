'use strict';

/*
 * The IO shell for the advisory post-rebase check: run one operator-authored command inside a
 * worktree, bounded, and report what happened. Every decision is in session/core/check-gate.js.
 *
 * SHELL, deliberately: the command is a config.json string ("npm test", "cargo test", "make check"),
 * and on Windows npm is a .cmd that execFile cannot run directly. It is arbitrary code either way, so
 * the guard is not argv construction but PROVENANCE: this string comes from the config file only, it
 * is not in any control-WS settable key list, and nothing an agent or a remote client sends can reach
 * it. That is the same rule `packs` and `remote` follow.
 *
 * Bounded and killed on overrun, because this runs unattended after an unattended rebase: a check that
 * hangs (a dev server started by a test script, a prompt nobody answers) must cost a timeout verdict,
 * never a wedged worktree or a leaked process tree.
 */

const fs = require('node:fs');
const path = require('node:path');

const { spawn } = require('./child-process-safe');
const { resolveCheckCommand, summarizeCheckResult } = require('../session/core/check-gate');

const DEFAULT_TIMEOUT_MS = 300_000;
// Enough of the tail to see which test failed, capped so a chatty runner cannot put a megabyte on a
// card tooltip or into a recording.
const MAX_TAIL_CHARS = 2000;

function readPackageJson(cwd, readFile) {
  try {
    return JSON.parse(readFile(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function createWorktreeCheck({
  spawnFn = spawn,
  readFile = fs.readFileSync,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  /**
   * @returns {{ command: string|null, source: string }} what would run in this worktree, without
   *   running it. Separate from run() so a caller can decide (and record) before spending anything.
   */
  function resolve({ cwd, projectCheckCommand, configCheckCommand }) {
    return resolveCheckCommand({
      projectCheckCommand,
      configCheckCommand,
      packageJson: readPackageJson(cwd, readFile),
    });
  }

  /** Never rejects: an advisory check that threw would be a worse outcome than one that failed. */
  function run({ cwd, command, timeoutMs: overrideTimeoutMs }) {
    const startedAt = now();
    return new Promise((resolve_) => {
      let child;
      try {
        child = spawnFn(command, { cwd, shell: true });
      } catch (error) {
        resolve_({ ...summarizeCheckResult({ error }), command, durationMs: now() - startedAt });
        return;
      }
      let output = '';
      let timedOut = false;
      let settled = false;
      const capture = (chunk) => {
        output = `${output}${chunk}`.slice(-MAX_TAIL_CHARS);
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* already gone */ }
      }, overrideTimeoutMs || timeoutMs);
      if (timer.unref) timer.unref();

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve_({ ...result, command, durationMs: now() - startedAt });
      };
      child.on('error', (error) => finish(summarizeCheckResult({ error, output })));
      child.on('close', (exitCode) => finish(summarizeCheckResult({ exitCode, timedOut, output })));
    });
  }

  return { resolve, run };
}

module.exports = { createWorktreeCheck, DEFAULT_TIMEOUT_MS, MAX_TAIL_CHARS };
