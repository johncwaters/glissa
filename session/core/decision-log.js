"use strict";

// Pure ring semantics for a session's DECISION TRACE: the ordered record of why each detection,
// gate and notification decision came out the way it did (sessions.js _recordDecision feeds it,
// getDebugState surfaces the tail, session-recorder mirrors it to JSONL). No IO, no Session import.
//
// Entry kinds (the caller supplies ts):
//   signal       one incoming detection signal: what the mapper decided and what the gate saw
//   gate         one decideGateRelease verdict with its inputs
//   notify       one explainNotification decision at a state entry
//   notify-state one NotificationManager lifecycle hop
//   pack         one context pack delivered as an --add-dir, skipped because it is not built, or a
//                staleness notice taken by a UserPromptSubmit hook response (decision: "notice")
//
// Collapse: the gate re-evaluates on every drain and every TTL tick, so an unchanged verdict would
// bury the interesting entries within seconds. Consecutive gate entries with the same decision and
// the same live-agent count fold into the last one, which counts them in `repeats` and carries the
// newest timing.

const DEFAULT_DECISION_LOG_CAP = 60;

function foldsIntoPrevious(previous, entry) {
  if (!previous || !entry) return false;
  if (previous.kind !== "gate" || entry.kind !== "gate") return false;
  return previous.decision === entry.decision && previous.active === entry.active;
}

// Appends `entry`, or folds it into the previous one. Returns "appended" or "collapsed" so the
// caller can mirror only genuinely new entries to the recorder.
function pushDecision(log, entry, cap = DEFAULT_DECISION_LOG_CAP) {
  const previous = log.length > 0 ? log[log.length - 1] : null;
  if (foldsIntoPrevious(previous, entry)) {
    previous.repeats = (previous.repeats || 1) + 1;
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

module.exports = { pushDecision, DEFAULT_DECISION_LOG_CAP };
