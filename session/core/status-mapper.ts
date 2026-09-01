import { STATES } from "../../shared/states.ts";

type LifecycleEvent = "new_output" | "user_input" | "task_complete" | "prompt_detected";

function mapSignalToEvent(
  signal: string,
  state: string,
  confidence?: string,
  activeAgents = 0,
): LifecycleEvent | null {
  switch (signal) {
    case "working":
    case "resume":

      if (state === STATES.IDLE || state === STATES.COMPLETE) return "new_output";
      if (state === STATES.WAITING) return "user_input";
      return null;
    case "ready":

      if (activeAgents > 0) return null;

      if (state === STATES.RUNNING) return "task_complete";
      if ((state === STATES.WAITING || state === STATES.IDLE) && confidence === "high") {
        return "task_complete";
      }
      return null;
    case "awaiting-input":

      if (state === STATES.RUNNING || state === STATES.IDLE || state === STATES.COMPLETE) {
        return "prompt_detected";
      }
      return null;
    case "session-start":
    case "session-end":

      return null;
    default:
      return null;
  }
}

export { mapSignalToEvent };
export type { LifecycleEvent };
