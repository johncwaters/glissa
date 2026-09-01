import type { SessionOptions } from '../../session/sessions.ts';

// The inert PTY stand-ins the Session tests spawn instead of a real terminal. Session drives only
// pid/onData/onExit/write/resize (session/sessions.ts SessionPty), so these are complete for it.

// A pid no process can hold, which keeps a kill or a liveness probe a harmless no-op.
const UNREACHABLE_PID = 2147483646;

interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

function fakePty(pid: number = UNREACHABLE_PID) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

// Retains the exit callback, so a test can fire the PTY exit by hand.
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

// Records what gets written to the terminal, so a paste handoff can be asserted.
function capturingPty(writes: string[], pid: number = UNREACHABLE_PID) {
  return { pid, onData() {}, onExit() {}, write(data: string) { writes.push(data); }, resize() {}, kill() {} };
}

// What node-pty is handed at spawn. Session always builds the env, so the capture states that.
type SpawnOptions = Parameters<NonNullable<SessionOptions['ptySpawn']>>[2] & {
  env: Record<string, string | undefined>;
};

interface SpawnCall {
  file: string;
  args: string[];
  opts: SpawnOptions;
}

// Records the spawn argv and environment, then hands back an inert terminal.
function spawnCapture(calls: SpawnCall[], pid: number = UNREACHABLE_PID) {
  return (file: string, args: string[], opts: Parameters<NonNullable<SessionOptions['ptySpawn']>>[2]) => {
    calls.push({ file, args, opts: opts as SpawnOptions });
    return fakePty(pid);
  };
}

export { fakePty, exitablePty, capturingPty, spawnCapture, UNREACHABLE_PID };
export type { PtyExitEvent, SpawnCall, SpawnOptions };
