const fs = require("node:fs");
const { STATES } = require("../shared/states");

// Pure state-machine tables for the Session lifecycle, extracted from sessions.js
// (relocated verbatim, behavior-preserving). The transition() engine in sessions.js
// consumes these. Guards/hooks receive the `session` instance as a parameter and call
// session.emit / read session.path|state|name; they never import Session, so there is
// no require cycle.

const TRANSITIONS = Object.freeze({
  [STATES.DORMANT]: {
    user_start: STATES.INITIALIZING,
  },
  [STATES.INITIALIZING]: {
    spawn_success: STATES.STARTING,
    spawn_fail: STATES.FAILED,
  },
  [STATES.STARTING]: {
    first_output: STATES.RUNNING,
    process_exit: STATES.FAILED,
  },
  [STATES.RUNNING]: {
    prompt_detected: STATES.WAITING,
    task_complete: STATES.COMPLETE,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
    user_kill: STATES.DONE,
  },
  [STATES.WAITING]: {
    user_input: STATES.RUNNING,
    user_dismiss: STATES.RUNNING,
    // Authoritative late `ready` (Stop/idle hook) while WAITING -> COMPLETE.
    task_complete: STATES.COMPLETE,
    user_kill: STATES.DONE,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
  },
  [STATES.IDLE]: {
    new_output: STATES.RUNNING,
    prompt_detected: STATES.WAITING,
    // Authoritative late `ready` while IDLE -> COMPLETE.
    task_complete: STATES.COMPLETE,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
    user_kill: STATES.DONE,
  },
  [STATES.COMPLETE]: {
    new_output: STATES.RUNNING,
    user_dismiss: STATES.IDLE,
    prompt_detected: STATES.WAITING,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
    user_kill: STATES.DONE,
  },
  [STATES.DONE]: {
    user_restart: STATES.INITIALIZING,
    // Close-out: a finished session whose worktree has been merged/discarded is reset to DORMANT so
    // its card parks for reuse (a fresh start re-forks a worktree off the now-updated integration
    // branch). Guarded (user_reset) so it never fires on a live PTY or unmerged work.
    user_reset: STATES.DORMANT,
  },
  [STATES.FAILED]: {
    user_restart: STATES.INITIALIZING,
    user_reset: STATES.DORMANT,
    process_exit_fail: STATES.FAILED,
  },
});

// Guards: return true if transition is allowed, false otherwise
const GUARDS = {
  spawn_success(session) {
    // Verify the dir the PTY was spawned in actually exists — the worktree when isolated, else path.
    return fs.existsSync(session.worktreeDir || session.path);
  },
  user_restart(session) {
    return session.state === STATES.DONE || session.state === STATES.FAILED;
  },
  user_reset(session) {
    // Allowed only once a finished session is fully settled: the PTY is dead AND the worktree has
    // already been merged/discarded (worktreeDir null). This prevents resetting a session whose work
    // is still on disk or whose PTY is alive, preserving "no implicit state mutation" and no data loss.
    return (
      (session.state === STATES.DONE || session.state === STATES.FAILED) &&
      session.ptyProcess == null &&
      session.worktreeDir == null
    );
  },
};

// Entry/exit hooks keyed by state
const ENTRY_HOOKS = {
  [STATES.COMPLETE](session) {
    // Turn ended, process still alive: the pre-/commit checkpoint. Emit-only
    // (purity contract); the backend listener runs the async post-turn checker.
    session.emit("post-turn-check", {
      id: session.id,
      name: session.name,
      // The worktree when isolated, so the auto-fixer edits the worktree, never the real checkout.
      path: session.worktreeDir || session.path,
    });
  },
  [STATES.WAITING](session) {
    session.emit("needs-attention", { name: session.name });
  },
  [STATES.FAILED](session) {
    session.emit("session-failed", { name: session.name });
  },
  [STATES.DONE](session) {
    session.emit("session-done", { name: session.name });
  },
};

const EXIT_HOOKS = {
  [STATES.WAITING](session) {
    session.emit("attention-cleared", { name: session.name });
  },
};

module.exports = { TRANSITIONS, GUARDS, ENTRY_HOOKS, EXIT_HOOKS };
