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

import cp from "node:child_process";
import type {
  ChildProcess,
  ExecException,
  ExecFileOptions,
  ExecFileOptionsWithStringEncoding,
  ExecFileSyncOptions,
  ExecFileSyncOptionsWithStringEncoding,
  ExecSyncOptions,
  ExecSyncOptionsWithStringEncoding,
  SpawnOptions,
} from "node:child_process";
import { promisify } from "node:util";

type ExecFileCallback = (
  error: ExecException | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

// Every caller leaves the encoding at its default, so both streams arrive decoded.
interface ExecFileResult {
  stdout: string;
  stderr: string;
}

type ExecFileFn = ((file: string, ...rest: unknown[]) => ChildProcess) & {
  [promisify.custom]: (file: string, ...rest: unknown[]) => Promise<ExecFileResult>;
};

// Force windowsHide:true into a child_process options object. Merged LAST so it
// always wins (no Glissa subprocess ever wants a window); a missing options
// object becomes one.
function hide(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== 'object') return { windowsHide: true };
  return { ...options, windowsHide: true };
}

// child_process accepts an optional (args, options, callback) trio after the
// command. Split them out by type so every documented call form normalizes
// before windowsHide is injected: array -> args, function -> callback, other
// object -> options.
function split(rest: unknown[]): {
  args: string[] | undefined;
  options: Record<string, unknown> | undefined;
  callback: ExecFileCallback | undefined;
} {
  let args: string[] | undefined;
  let options: Record<string, unknown> | undefined;
  let callback: ExecFileCallback | undefined;
  for (const v of rest) {
    if (Array.isArray(v) && v.every((entry) => typeof entry === 'string')) args = v;
    if (typeof v === "function") callback = v as ExecFileCallback;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      options = v as Record<string, unknown>;
    }
  }
  return { args, options, callback };
}

const execFile: ExecFileFn = Object.assign(
  function execFile(file: string, ...rest: unknown[]): ChildProcess {
    const { args, options, callback } = split(rest);
    const execOptions = hide(options) as ExecFileOptions;
    return cp.execFile(file, args, execOptions, callback);
  },
  {
    // Preserve child_process.execFile's PROMISIFIED contract: resolve { stdout,
    // stderr }, reject with an Error carrying .stdout/.stderr. Every async caller
    // consumes this via execFileAsync below; a default-promisified wrapper would
    // resolve with stdout only and break it. Built by hand (not by copying cp's
    // custom symbol) so cp.execFile is still called at call time WITH windowsHide.
    [promisify.custom]: (file: string, ...rest: unknown[]) => new Promise<ExecFileResult>((resolve, reject) => {
      const { args, options } = split(rest);
      // No caller overrides `encoding`, so the child_process default (utf8) decodes both streams.
      const execOptions = hide(options) as ExecFileOptionsWithStringEncoding;
      const callback = (err: ExecException | null, stdout: string, stderr: string) => {
        if (err) {
          const failure = err as ExecException & { stdout?: string; stderr?: string };
          failure.stdout = stdout;
          failure.stderr = stderr;
          return reject(failure);
        }
        resolve({ stdout, stderr });
      };
      cp.execFile(file, args, execOptions, callback);
    }),
  },
);

function execFileSync(file: string, options: ExecFileSyncOptionsWithStringEncoding): string;
function execFileSync(file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
function execFileSync(file: string, options?: ExecFileSyncOptions): string | Buffer;
function execFileSync(file: string, args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
function execFileSync(file: string, ...rest: unknown[]): string | Buffer {
  const { args, options } = split(rest);
  const execOptions = hide(options) as ExecFileSyncOptions;
  if (args) return cp.execFileSync(file, args, execOptions);
  return cp.execFileSync(file, execOptions);
}

function execSync(command: string, options: ExecSyncOptionsWithStringEncoding): string;
function execSync(command: string, options?: ExecSyncOptions): string | Buffer;
function execSync(command: string, options?: ExecSyncOptions): string | Buffer {
  return cp.execSync(command, hide(options) as ExecSyncOptions);
}

function spawn(file: string, ...rest: unknown[]): ChildProcess {
  const { args, options } = split(rest);
  const spawnOptions = hide(options) as SpawnOptions;
  if (args) return cp.spawn(file, args, spawnOptions);
  return cp.spawn(file, spawnOptions);
}

// The promisified form every async caller wants, built once here so no call site has to remember that
// execFile carries a custom promisify contract ({ stdout, stderr }, not stdout alone).
const execFileAsync = promisify(execFile);

export { execFile, execFileAsync, execFileSync, execSync, spawn, hide };
export type { ExecFileCallback, ExecFileResult };
