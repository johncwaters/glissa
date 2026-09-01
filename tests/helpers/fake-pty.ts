import type { SessionOptions } from '../../session/sessions.ts';

const UNREACHABLE_PID = 2147483646;

interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

function fakePty(pid: number = UNREACHABLE_PID) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

function exitablePty(pid: number = UNREACHABLE_PID) {
  let onExitHandler: ((event: PtyExitEvent) => void) | null = null;
  return {
    pid,
    onData() {},
    onExit(cb: (event: PtyExitEvent) => void) { onExitHandler = cb; },
    write() {},
    resize() {},
    kill() {},
    fireExit(exitCode = 0) { if (onExitHandler) onExitHandler({ exitCode, signal: 0 }); },
  };
}

function capturingPty(writes: string[], pid: number = UNREACHABLE_PID) {
  return { pid, onData() {}, onExit() {}, write(data: string) { writes.push(data); }, resize() {}, kill() {} };
}

type SpawnOptions = Parameters<NonNullable<SessionOptions['ptySpawn']>>[2] & {
  env: Record<string, string | undefined>;
};

interface SpawnCall {
  file: string;
  args: string[];
  opts: SpawnOptions;
}

function spawnCapture(calls: SpawnCall[], pid: number = UNREACHABLE_PID) {
  return (file: string, args: string[], opts: Parameters<NonNullable<SessionOptions['ptySpawn']>>[2]) => {
    calls.push({ file, args, opts: opts as SpawnOptions });
    return fakePty(pid);
  };
}

export { fakePty, exitablePty, capturingPty, spawnCapture, UNREACHABLE_PID };
export type { PtyExitEvent, SpawnCall, SpawnOptions };
