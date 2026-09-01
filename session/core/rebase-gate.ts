import { STATES } from "../../shared/states.ts";

interface AutoRebaseInputs {
  enabled?: boolean;
  trigger?: string;
  state?: string;
  hasLivePty?: boolean;
  mergeStatus?: string;
  dirty?: boolean;
  behind?: string | number | null;
  rebaseInProgress?: boolean;
  teardownPending?: boolean;
  currentKey?: string | null;
  lastConflictKey?: string | null;
}

interface AutoRebaseVerdict {
  action: "rebase" | "skip";
  reason?: string;
}

interface RerereCooldownInputs {
  enabled?: boolean;
  hasCooldown?: boolean;
  teardownPending?: boolean;
}

const AUTO_REBASE_STATES: readonly string[] = Object.freeze([
  STATES.IDLE,
  STATES.COMPLETE,
  STATES.DONE,
  STATES.FAILED,
  STATES.DORMANT,
]);

const SPAWN_GAP_TRIGGER = "fresh-restart";

function isZeroCount(count: string | number | null | undefined): boolean {
  if (count === null || count === undefined) return true;
  return String(count).trim() === "" || Number(count) === 0;
}

function skip(reason: string): AutoRebaseVerdict {
  return { action: "skip", reason };
}

function decideAutoRebase({
  enabled,
  trigger,
  state,
  hasLivePty,
  mergeStatus,
  dirty,
  behind,
  rebaseInProgress,
  teardownPending,
  currentKey,
  lastConflictKey,
}: AutoRebaseInputs = {}): AutoRebaseVerdict {
  const spawnGap = trigger === SPAWN_GAP_TRIGGER;
  if (!enabled) return skip("disabled");
  if (teardownPending) return skip("teardown");
  if (mergeStatus === "merging") return skip("merging");
  if (mergeStatus === "parked") return skip("parked");
  if (spawnGap && hasLivePty) return skip("live-pty");
  if (!spawnGap && (typeof state !== "string" || !AUTO_REBASE_STATES.includes(state))) return skip("busy");
  if (rebaseInProgress) return skip("rebase-in-progress");
  if (dirty) return skip("dirty");
  if (isZeroCount(behind)) return skip("current");
  if (currentKey && currentKey === lastConflictKey) return skip("conflict-cooldown");
  return { action: "rebase" };
}

function decideRerereCooldownClear(
  { enabled, hasCooldown, teardownPending }: RerereCooldownInputs = {},
): { clear: boolean; reason: string } {
  if (!enabled) return { clear: false, reason: "disabled" };
  if (teardownPending) return { clear: false, reason: "teardown" };
  if (!hasCooldown) return { clear: false, reason: "no-cooldown" };
  return { clear: true, reason: "rerere-recorded" };
}

export { decideAutoRebase, decideRerereCooldownClear, AUTO_REBASE_STATES, SPAWN_GAP_TRIGGER };
export type { AutoRebaseInputs, AutoRebaseVerdict, RerereCooldownInputs };
