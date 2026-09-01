const DEFAULT_GATE_RELEASE_SETTLE_MS = 10 * 1000;

interface GateReleaseInputs {
  heldState?: string;
  currentState?: string;
  activeAgents?: number;
  stashSeq?: number;
  lastActivitySeq?: number;
  stashTs?: number;
  quietSince?: number;
  now?: number;
  settleMs?: number;
}

interface GateReleaseVerdict {
  decision: "cancel" | "gated" | "wait" | "release";
  waitMs: number;
}

function decideGateRelease({
  heldState,
  currentState,
  activeAgents = 0,
  stashSeq = 0,
  lastActivitySeq = 0,
  stashTs = 0,
  quietSince = 0,
  now = 0,
  settleMs = DEFAULT_GATE_RELEASE_SETTLE_MS,
}: GateReleaseInputs = {}): GateReleaseVerdict {
  if (currentState !== heldState) return { decision: "cancel", waitMs: 0 };

  if (lastActivitySeq > stashSeq) return { decision: "cancel", waitMs: 0 };
  if (activeAgents > 0) return { decision: "gated", waitMs: 0 };
  const quietFor = now - Math.max(quietSince, stashTs);
  if (quietFor < settleMs) return { decision: "wait", waitMs: settleMs - quietFor };
  return { decision: "release", waitMs: 0 };
}

export { decideGateRelease, DEFAULT_GATE_RELEASE_SETTLE_MS };
export type { GateReleaseInputs, GateReleaseVerdict };
