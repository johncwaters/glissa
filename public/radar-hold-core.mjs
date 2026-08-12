// ── Radar render hold (pure) ─────────────────────────────────
// Radar rebuilds its rows wholesale on every feed broadcast, and a row action's progress and outcome
// line live INSIDE a row. Repainting mid-request would drop the in-flight disable (inviting a double
// fire) and wipe an outcome the operator has not read yet, so a broadcast that lands while any action
// is in flight is HELD and applied once every action has settled and its outcome has been readable
// for a beat.
//
// Extracted from radar-panel.js because the DOM half is untestable and this half is where the
// ordering defects live. The server broadcasts the new board BEFORE it replies to the request that
// caused it (see server/posthog-wiring.js archiveInvestigation), so the held repaint routinely
// arrives BEFORE the settle that is supposed to release it, and a held repaint that arrives while a
// second action is running has to survive a hold window expiring under it.
//
// The one invariant, and the reason this is a module rather than four module-level variables: A HELD
// REPAINT ALWAYS OWNS A LIVE TIMER. It is never owed to a settle() that may already have run.
//
// No DOM, no globals: `render` and both timer functions are injected, so a test drives the whole
// state machine on a fake clock.

// How long a settled action's outcome line survives before the held broadcast repaints the rows. Long
// enough to read one short line, short enough that the board is never meaningfully stale.
export const OUTCOME_READ_MS = 4000;

export function createRenderHold({
  render,
  holdMs = OUTCOME_READ_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const pending = new Set();
  let held = false;
  let timer = null;

  // `restart` is for a freshly written outcome line: it gets the full window, even when a window
  // opened by an earlier event is most of the way through.
  function arm(restart) {
    if (timer !== null && !restart) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(fire, holdMs);
  }

  function fire() {
    timer = null;
    // Still busy: keep the hold alive rather than handing the held repaint to a settle that may
    // already have run. This is the interleaving that used to strand a repaint forever - the board
    // then showed a row the operator had already archived until the next poll, minutes later.
    if (pending.size > 0) {
      arm(false);
      return;
    }
    if (!held) return;
    held = false;
    render();
  }

  return {
    // An action started. Tokens are per row+verb, so a repeated token is the same control firing
    // twice and collapses, exactly as a Set should.
    begin(token) {
      pending.add(token);
    },
    // An action finished (ok or error) and wrote its outcome line.
    settle(token) {
      pending.delete(token);
      arm(true);
    },
    // A feed wants the board repainted. Renders straight through when nothing is in flight and no
    // outcome line is still being read.
    request() {
      if (pending.size === 0 && timer === null) {
        render();
        return;
      }
      held = true;
      arm(false);
    },
    // Test/debug introspection only; nothing in the panel branches on these.
    _state() {
      return { pending: pending.size, held, armed: timer !== null };
    },
  };
}
