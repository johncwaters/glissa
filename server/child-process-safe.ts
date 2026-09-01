
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

interface ExecFileResult {
  stdout: string;
  stderr: string;
}

type ExecFileFn = ((file: string, ...rest: unknown[]) => ChildProcess) & {
  [promisify.custom]: (file: string, ...rest: unknown[]) => Promise<ExecFileResult>;
};

function hide(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== 'object') return { windowsHide: true };
  return { ...options, windowsHide: true };
}

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
    [promisify.custom]: (file: string, ...rest: unknown[]) => new Promise<ExecFileResult>((resolve, reject) => {
      const { args, options } = split(rest);
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

const execFileAsync = promisify(execFile);

export { execFile, execFileAsync, execFileSync, execSync, spawn, hide };
export type { ExecFileCallback, ExecFileResult };
