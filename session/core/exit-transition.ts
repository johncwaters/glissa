import { STATES } from "../../shared/states.ts";

type ExitSignal = number | string | null | undefined;

interface ExitTransition {
  event: "process_exit" | "process_exit_ok" | "process_exit_fail";
  detail: { exitCode: number; signal: ExitSignal; reason?: string };
}

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
