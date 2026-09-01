import type { MergeStatus } from "./worktree-state.ts";

const REVIEWABLE: MergeStatus[] = ["pending-review", "parked"];

interface WorktreeSignature {
  dirty: boolean;
  ahead: string;
  behind: string;
  rebaseInProgress: boolean;
}

function isZero(count: string): boolean {
  return count === "" || count === "0";
}

function decideSignatureDemotion(mergeStatus: MergeStatus, sig: WorktreeSignature): MergeStatus | null {
  if (REVIEWABLE.includes(mergeStatus) && !sig.dirty && isZero(sig.ahead)) return "none";
  if (mergeStatus === "parked" && !sig.dirty && !isZero(sig.ahead)
      && isZero(sig.behind) && !sig.rebaseInProgress) return "pending-review";
  return null;
}

function decideBaseSyncDemotion(
  mergeStatus: MergeStatus,
  mergeReason: string | null,
  baseSyncState: string,
): MergeStatus | null {
  if (mergeStatus !== "parked" || mergeReason !== "base-diverged") return null;
  if (!["in-sync", "ahead", "behind"].includes(baseSyncState)) return null;
  return "pending-review";
}

function decideDiffSelfHeal(
  mergeStatus: MergeStatus,
  committedDiff: string,
  uncommittedDiff: string,
): MergeStatus | null {
  if (!REVIEWABLE.includes(mergeStatus)) return null;
  if (committedDiff.trim() !== "" || uncommittedDiff.trim() !== "") return null;
  return "none";
}

export { decideSignatureDemotion, decideBaseSyncDemotion, decideDiffSelfHeal };
export type { WorktreeSignature };
