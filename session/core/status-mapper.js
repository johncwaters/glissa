const { STATES } = require("../../shared/states");

// Pure decision function extracted from Session._onStatus (behavior-preserving).
// Maps a normalized status signal + the session's current state (+ confidence, for the
// late-`ready` authoritative gate) to the lifecycle event to fire, or null for "no
// transition". It is side-effect free: the _onStatus wrapper assembles the uniform
// detail { source, signal } and performs the actual this.transition(...). There is NO
// screen-content parsing here and NO Session import, so no require cycle.
function mapSignalToEvent(signal, state, confidence, activeAgents = 0) {
  switch (signal) {
    case "working":
    case "resume":
      // Claude is active again - wake a quiescent card.
      if (state === STATES.IDLE || state === STATES.COMPLETE) return "new_output";
      if (state === STATES.WAITING) return "user_input";
      return null;
    case "ready":
      // Turn finished. But if background sub-agents are still running (activeAgents > 0), the
      // main agent's Stop must NOT complete the card: work continues and the main agent will
      // auto-resume. Suppress here; the resumed turn's later Stop (with the count back to 0)
      // completes normally. This gate applies to every `ready` source (hook or title) so the
      // title fallback cannot prematurely complete either.
      if (activeAgents > 0) return null;
      // Authoritative (hook) `ready` may complete from WAITING/IDLE too (a late Stop after a
      // permission/idle prompt). The title fallback only completes from RUNNING (it only emits
      // ready after seeing a spinner).
      if (state === STATES.RUNNING) return "task_complete";
      if ((state === STATES.WAITING || state === STATES.IDLE) && confidence === "high") {
        return "task_complete";
      }
      return null;
    case "awaiting-input":
      // Needs the user. Hooks are the usual source; a title profile emits it only where the agent
      // writes an explicit awaiting-input STATE (codex's Action Required), never as an inference.
      if (state === STATES.RUNNING || state === STATES.IDLE || state === STATES.COMPLETE) {
        return "prompt_detected";
      }
      return null;
    case "session-start":
    case "session-end":
      // Lifecycle telemetry only - PTY first-output / exit drive these states.
      return null;
    default:
      return null;
  }
}

module.exports = { mapSignalToEvent };
