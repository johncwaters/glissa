// Pure ring semantics for a session's DECISION TRACE: the ordered record of why each detection,
// gate and notification decision came out the way it did (sessions.js _recordDecision feeds it,
// getDebugState surfaces the tail, session-recorder mirrors it to JSONL). No IO, no Session import.
//
// Entry kinds (the caller supplies ts):
//   signal       one incoming detection signal: what the mapper decided and what the gate saw
//   gate         one decideGateRelease verdict with its inputs
//   notify       one explainNotification decision at a state entry
//   notify-state one NotificationManager lifecycle hop
//   pack         one context pack delivered as an --add-dir, skipped because it is not built, refused
//                because the session's agent does not deliver packs (decision: "unsupported"), or a
//                staleness notice taken by a UserPromptSubmit hook response (decision: "notice")
//   rebase       one eager auto-rebase onto a moved integration branch: "auto-rebased" (with the shas
//                and whether rerere carried it), "conflict" (with the conflicting files), or
//                "state-moved" (a turn started while the rebase was rewriting the worktree)
//
// Every entry may also carry `agent`, the id of the agent adapter the session supervises. It is
// stamped only when that is NOT the default (claude-code), which the recording header already names.
//
// Collapse: the gate re-evaluates on every drain and every TTL tick, so an unchanged verdict would
// bury the interesting entries within seconds. Consecutive gate entries with the same decision and
// the same live-agent count fold into the last one, which counts them in `repeats` and carries the
// newest timing.

const DEFAULT_DECISION_LOG_CAP = 60;

// Heterogeneous by design: the kinds above share only `kind` and `ts`, and each carries its own evidence.
type DecisionEntry = Record<string, unknown>;

function foldsIntoPrevious(previous: DecisionEntry | null, entry: DecisionEntry | null): boolean {
  if (!previous || !entry) return false;
  if (previous.kind !== "gate" || entry.kind !== "gate") return false;
  return previous.decision === entry.decision && previous.active === entry.active;
}

// Appends `entry`, or folds it into the previous one. Returns "appended" or "collapsed" so the
// caller can mirror only genuinely new entries to the recorder.
function pushDecision(
  log: DecisionEntry[],
  entry: DecisionEntry,
  cap = DEFAULT_DECISION_LOG_CAP,
): "appended" | "collapsed" {
  const previous = log.length > 0 ? log[log.length - 1] : null;
  if (previous && foldsIntoPrevious(previous, entry)) {
    const previousRepeats = typeof previous.repeats === "number" ? previous.repeats : 1;
    previous.repeats = previousRepeats + 1;
    previous.ts = entry.ts;
    previous.waitMs = entry.waitMs;
    previous.quietMs = entry.quietMs;
    previous.lastActivitySeq = entry.lastActivitySeq;
    return "collapsed";
  }
  log.push(entry);
  if (log.length > cap) log.splice(0, log.length - cap);
  return "appended";
}

export { pushDecision, DEFAULT_DECISION_LOG_CAP };
export type { DecisionEntry };
