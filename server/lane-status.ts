interface LaneGate {
  start: boolean;
  reason?: string | null;
}

type EmptyLaneStatus = {
  type: string;
  ts: number;
  configured: boolean;
  reason: string | null | undefined;
  projects: unknown[];
};

function emptyLaneStatus(type: string, gate: LaneGate): EmptyLaneStatus {
  return { type, ts: Date.now(), configured: gate.start, reason: gate.reason, projects: [] };
}

export { emptyLaneStatus };
export type { EmptyLaneStatus, LaneGate };
