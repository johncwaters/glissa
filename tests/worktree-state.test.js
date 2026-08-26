"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { projectMergeState } = require("../session/core/worktree-state");

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
