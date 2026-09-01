const DEFAULT_DECISION_LOG_CAP = 60;

type DecisionEntry = Record<string, unknown>;

function foldsIntoPrevious(previous: DecisionEntry | null, entry: DecisionEntry | null): boolean {
  if (!previous || !entry) return false;
  if (previous.kind !== "gate" || entry.kind !== "gate") return false;
  return previous.decision === entry.decision && previous.active === entry.active;
}

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
