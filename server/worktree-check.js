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

// TREE kill: child.kill() reaches only the shell while npm and the runner keep handles inside the worktree, so win32 reuses the PTY path's taskkill /T /F and POSIX group-signals the detached child (-pid).
function reapTree(child, { platform, killTree, killGroup }) {
  const killChildOnly = () => {
    try { child.kill(); } catch { /* already gone */ }
  };
  if (platform !== 'win32') {
    // signalablePid rule (sessions.js): negated, pid 0 is our OWN group and pid 1 is everything this user can signal, so below 2 only the child itself is signalled.
    const groupPid = Number.isInteger(child.pid) && child.pid > 1 ? child.pid : null;
    if (groupPid === null) return killChildOnly();
    try { killGroup(-groupPid, 'SIGKILL'); } catch { /* best-effort: any signal failure is treated as already gone */ }
    return;
  }
  // Windows negates nothing (taskkill takes the pid as given), so it needs no such guard.
  if (!child.pid) return killChildOnly();
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
  killGroup = (pid, signal) => process.kill(pid, signal),
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
        // detached off Windows so the shell leads its own process group and reapTree can signal the whole
        // tree; on Windows it would open a console window, and taskkill /T needs nothing from us.
        child = spawnFn(command, { cwd, shell: true, detached: platform !== 'win32' });
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
        reapTree(child, { platform, killTree, killGroup });
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
