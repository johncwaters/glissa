import { STATES } from "../../shared/states.ts";

// node-pty reports a numeric signal, a kill path may report its name, and a clean exit reports none.
type ExitSignal = number | string | null | undefined;

interface ExitTransition {
  event: "process_exit" | "process_exit_ok" | "process_exit_fail";
  detail: { exitCode: number; signal: ExitSignal; reason?: string };
}

// Maps a real PTY exit (current state + exit code/signal + whether the STARTING PTY ever
// produced output) to the lifecycle event/detail to fire. Side-effect free: the caller
// performs the actual this.transition(event, detail) and reads detail.reason (only ever
// set on the no-output branch) for its own "exit" emit.
function decideExitTransition(
  state: string,
  exitCode: number,
  signal: ExitSignal,
  receivedFirstOutput: boolean,
): ExitTransition {
  if (state === STATES.STARTING && !receivedFirstOutput) {
    return { event: "process_exit", detail: { exitCode, signal, reason: "no_output_before_exit" } };
  }
  if (exitCode === 0) {
    return { event: "process_exit_ok", detail: { exitCode, signal } };
  }
  if (state === STATES.STARTING) {
    return { event: "process_exit", detail: { exitCode, signal } };
  }
  return { event: "process_exit_fail", detail: { exitCode, signal } };
}

export { decideExitTransition };
export type { ExitSignal, ExitTransition };
