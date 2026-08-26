"use strict";

// ---------------------------------------------------------------------------
// child-process-safe: the ONE module that spawns child processes in Glissa.
//
// node:child_process defaults `windowsHide` to false. On Windows, a console
// child (git, taskkill, cmd, powershell, msg, where, ...) spawned by a process
// that owns no console - Glissa runs as a background server, launched from a
// shortcut, an npm script, or the detached self-respawn - pops its OWN visible,
// focus-stealing console window for the child's lifetime. At session start the
// worktree probes plus the junction mklinks, and at stop/restart the taskkill plus
// the merge-back git calls, fire several of these at once: a burst of CMD
// windows that steals focus and blocks the operator.
//
// The fix is `windowsHide: true` on EVERY spawn. Setting it per call site is
// bandaid-prone: it is one option among several and is silently forgettable (it
// WAS missed at multiple sites). So this module wraps child_process and FORCES
// `windowsHide: true` in, and it is the ONLY module allowed to import
// child_process directly: tests/no-direct-child-process.test.js fails if any
// other runtime module imports it. A new spawn site cannot reintroduce the
// flash. `windowsHide` is ignored on non-Windows, so this is safe anywhere.
//
// Exceptions to "go through this module": server-lifecycle.js receives its spawn
// as an injected seam and sets windowsHide itself (its own unit-tested contract);
// scripts/ are manual terminal tools (they already own a console). Neither
// imports child_process directly, so neither trips the guard test.
// ---------------------------------------------------------------------------

const cp = require("node:child_process");
const { promisify } = require("node:util");

// Force windowsHide:true into a child_process options object. Merged LAST so it
// always wins (no Glissa subprocess ever wants a window); a missing options
// object becomes one.
/** @param {unknown} options */
function hide(options) {
  if (!options || typeof options !== 'object') return { windowsHide: true };
  return { ...options, windowsHide: true };
}

// child_process accepts an optional (args, options, callback) trio after the
// command. Split them out by type so every documented call form normalizes
// before windowsHide is injected: array -> args, function -> callback, other
// object -> options.
/**
 * @typedef {(error: import('node:child_process').ExecException | null, stdout: string | Buffer, stderr: string | Buffer) => void} ExecFileCallback
 */

/** @param {unknown[]} rest */
function split(rest) {
  /** @type {string[] | undefined} */
  let args;
  /** @type {Record<string, unknown> | undefined} */
  let options;
  /** @type {ExecFileCallback | undefined} */
  let callback;
  for (const v of rest) {
    if (Array.isArray(v) && v.every((entry) => typeof entry === 'string')) args = v;
    if (typeof v === "function") callback = /** @type {ExecFileCallback} */ (v);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      options = /** @type {Record<string, unknown>} */ (v);
    }
  }
  return { args, options, callback };
}

/** @param {string} file @param {...unknown} rest */
function execFile(file, ...rest) {
  const { args, options, callback } = split(rest);
  const execOptions = /** @type {import('node:child_process').ExecFileOptions} */ (hide(options));
  return cp.execFile(file, args, execOptions, callback);
}

// Preserve child_process.execFile's PROMISIFIED contract: resolve { stdout,
// stderr }, reject with an Error carrying .stdout/.stderr. Every async caller
// consumes this via execFileAsync below; a default-promisified wrapper would
// resolve with stdout only and break it. Built by hand (not by copying cp's
// custom symbol) so cp.execFile is still called at call time WITH windowsHide.
execFile[promisify.custom] = (file, ...rest) =>
  new Promise((resolve, reject) => {
    const { args, options } = split(rest);
    const execOptions = /** @type {import('node:child_process').ExecFileOptions} */ (hide(options));
    const callback = (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    };
    cp.execFile(file, args, execOptions, callback);
  });

/**
 * @overload
 * @param {string} file
 * @param {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} options
 * @returns {string}
 */
/**
 * @overload
 * @param {string} file
 * @param {readonly string[]} args
 * @param {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} options
 * @returns {string}
 */
/**
 * @overload
 * @param {string} file
 * @param {import('node:child_process').ExecFileSyncOptions} [options]
 * @returns {string | Buffer}
 */
/**
 * @overload
 * @param {string} file
 * @param {readonly string[]} args
 * @param {import('node:child_process').ExecFileSyncOptions} [options]
 * @returns {string | Buffer}
 */
/** @param {string} file @param {...unknown} rest @returns {string | Buffer} */
function execFileSync(file, ...rest) {
  const { args, options } = split(rest);
  const execOptions = /** @type {import('node:child_process').ExecFileSyncOptions} */ (hide(options));
  if (args) return cp.execFileSync(file, args, execOptions);
  return cp.execFileSync(file, execOptions);
}

/**
 * @overload
 * @param {string} command
 * @param {import('node:child_process').ExecSyncOptionsWithStringEncoding} options
 * @returns {string}
 */
/**
 * @overload
 * @param {string} command
 * @param {import('node:child_process').ExecSyncOptions} [options]
 * @returns {string | Buffer}
 */
/** @param {string} command @param {import('node:child_process').ExecSyncOptions} [options] @returns {string | Buffer} */
function execSync(command, options) {
  return cp.execSync(command, hide(options));
}

/** @param {string} file @param {...unknown} rest */
function spawn(file, ...rest) {
  const { args, options } = split(rest);
  const spawnOptions = /** @type {import('node:child_process').SpawnOptions} */ (hide(options));
  if (args) return cp.spawn(file, args, spawnOptions);
  return cp.spawn(file, spawnOptions);
}

// The promisified form every async caller wants, built once here so no call site has to remember that
// execFile carries a custom promisify contract ({ stdout, stderr }, not stdout alone).
const execFileAsync = promisify(execFile);

module.exports = { execFile, execFileAsync, execFileSync, execSync, spawn, hide };
