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

const { execFile, spawn } = require('./child-process-safe');
const { resolveCheckCommand, summarizeCheckResult } = require('../session/core/check-gate');

const DEFAULT_TIMEOUT_MS = 300_000;
// Enough of the tail to see which test failed, capped so a chatty runner cannot put a megabyte on a
// card tooltip or into a recording.
const MAX_TAIL_CHARS = 2000;

// ASYNC: resolve() runs on the watcher-driven rebase path, and all sessions share one event loop, so
// a synchronous read here would stall every other session for the duration (AGENTS.md, no sync fs on
// recurring paths).
async function readPackageJson(cwd, readFile) {
  try {
    return JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/*
 * Killing a shell-spawned check on Windows. `child.kill()` signals cmd.exe alone, and the tree under
 * it - npm.cmd, node, the test runner - survives, holding open handles INSIDE the worktree: the
 * timeout then reports a verdict while the run it timed out on keeps writing there, and the next
 * auto-rebase fails on those handles. This is the same taskkill /T /F reap the PTY path uses
 * (sessions.js _taskkill). Every other platform keeps child.kill(), where killing the process group
 * is not this problem.
 */
function reapTree(child, { platform, killTree }) {
  if (platform !== 'win32' || !child.pid) {
    try { child.kill(); } catch { /* already gone */ }
    return;
  }
  killTree(['/PID', String(child.pid), '/T', '/F'], {}, () => {
    // Best-effort: an already-dead tree is the normal case, and the close handler is what settles the
    // verdict either way.
  });
}

function createWorktreeCheck({
  spawnFn = spawn,
  readFile = fs.promises.readFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  platform = process.platform,
  killTree = (args, opts, cb) => execFile('taskkill', args, opts, cb),
} = {}) {
  /**
   * @returns {Promise<{ command: string|null, source: string }>} what would run in this worktree,
   *   without running it. Separate from run() so a caller can decide (and record) before spending
   *   anything.
   */
  async function resolve({ cwd, projectCheckCommand, configCheckCommand }) {
    return resolveCheckCommand({
      projectCheckCommand,
      configCheckCommand,
      packageJson: await readPackageJson(cwd, readFile),
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
        reapTree(child, { platform, killTree });
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
