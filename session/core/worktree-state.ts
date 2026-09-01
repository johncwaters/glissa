type MergeStatus = "none" | "pending-review" | "merging" | "parked" | "merged";
interface MergeStatusDetail {
  reason?: string | null;
  conflicts?: string[];
}
interface MergeState {
  mergeStatus: MergeStatus;
  mergeReason: string | null;
  mergeConflicts: string[];
}

function projectMergeState(mergeStatus: MergeStatus, detail: MergeStatusDetail = {}): MergeState {
  if (mergeStatus !== "parked") {
    return { mergeStatus, mergeReason: null, mergeConflicts: [] };
  }
  return {
    mergeStatus,
    mergeReason: detail.reason || null,
    mergeConflicts: Array.isArray(detail.conflicts) ? detail.conflicts : [],
  };
}

export { projectMergeState };
export type { MergeState, MergeStatus, MergeStatusDetail };
