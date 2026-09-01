import test from "node:test";
import assert from "node:assert/strict";
import { projectMergeState } from "../session/core/worktree-state.ts";

test("projectMergeState retains conflict context only while parked", () => {
  assert.deepEqual(projectMergeState("parked", { reason: "conflict", conflicts: ["a.js"] }), {
    mergeStatus: "parked",
    mergeReason: "conflict",
    mergeConflicts: ["a.js"],
  });
  assert.deepEqual(projectMergeState("pending-review", { reason: "stale", conflicts: ["old.js"] }), {
    mergeStatus: "pending-review",
    mergeReason: null,
    mergeConflicts: [],
  });
});
