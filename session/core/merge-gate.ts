// Pure review-gate demotion decisions, extracted from Session.checkWorktreeChange /
// Session.getDiff. Both consumers apply the returned status via _setMergeStatus; the
// decisions themselves have no side effects so the full matrix is unit-testable.

const REVIEWABLE = ["pending-review", "parked"];

interface WorktreeSignature {
  dirty: boolean;
  ahead: string;
  behind: string;
  rebaseInProgress: boolean;
}

function isZero(count: string): boolean {
  return count === "" || count === "0";
}

// Gate demotion for a fresh worktree signature { dirty, ahead, behind, rebaseInProgress }.
// Returns the next mergeStatus or null (no demotion).
//   - A reviewable gate over a clean, un-ahead worktree self-heals to 'none' (the operator
//     merged or cleaned out-of-band; nothing reviewable remains).
//   - A parked merge whose worktree is clean, sits on top of the merge target (behind 0),
//     and is not mid-rebase is mergeable again: hand Merge back by demoting to
//     'pending-review' (NOT 'none': the committed work is still unmerged and reviewable).
function decideSignatureDemotion(mergeStatus: string, sig: WorktreeSignature): string | null {
  if (REVIEWABLE.includes(mergeStatus) && !sig.dirty && isZero(sig.ahead)) return "none";
  if (mergeStatus === "parked" && !sig.dirty && !isZero(sig.ahead)
      && isZero(sig.behind) && !sig.rebaseInProgress) return "pending-review";
  return null;
}

function decideBaseSyncDemotion(mergeStatus: string, mergeReason: string | null, baseSyncState: string): string | null {
  if (mergeStatus !== "parked" || mergeReason !== "base-diverged") return null;
  if (!["in-sync", "ahead", "behind"].includes(baseSyncState)) return null;
  return "pending-review";
}

// Self-heal for a stranded review gate over an empty diff (operator committed-and-merged
// or cleaned the worktree inside the still-live PTY). Returns 'none' or null.
function decideDiffSelfHeal(
  mergeStatus: string,
  committedDiff: string,
  uncommittedDiff: string,
): string | null {
  if (!REVIEWABLE.includes(mergeStatus)) return null;
  if (committedDiff.trim() !== "" || uncommittedDiff.trim() !== "") return null;
  return "none";
}

export { decideSignatureDemotion, decideBaseSyncDemotion, decideDiffSelfHeal };
export type { WorktreeSignature };
