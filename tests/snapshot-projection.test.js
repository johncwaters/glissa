"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { projectSessionSnapshots } = require("../session/core/snapshot-projection");

function snapshotSource() {
  return {
    id: "s1",
    name: "Session One",
    path: "/repo",
    agent: "claude-code",
    state: "COMPLETE",
    stateSince: 42,
    sleeping: false,
    dangerouslySkipPermissions: false,
    ephemeral: false,
    isWorktree: true,
    resumeSessionId: "resume-1",
    activeAgents: 0,
    packs: [{ name: "rules", version: "v1", dir: "/private/rules" }],
    pendingWakeup: null,
    pendingPromptKind: null,
    mergeStatus: "pending-review",
    mergeReason: null,
    worktreeNotice: null,
    effectiveBase: "main",
    auditLog: [{ from: "RUNNING", to: "COMPLETE", event: "task_complete", timestamp: 41, detail: { source: "hook" } }],
    detection: { hookSeen: true },
    decisions: [{ kind: "signal", decision: "transition" }],
  };
}

test("wire and debug snapshots share state and redacted pack projections", () => {
  const { wire, debug } = projectSessionSnapshots(snapshotSource());
  assert.equal(debug.state, wire.state);
  assert.equal(debug.packs, wire.packs);
  assert.deepEqual(wire.packs, [{ name: "rules", version: "v1" }]);
  assert.equal(wire.effectiveBase, "main");
  assert.deepEqual(debug.transitions, [{
    from: "RUNNING",
    to: "COMPLETE",
    event: "task_complete",
    timestamp: 41,
    detail: { source: "hook" },
  }]);
});

test("debug projection retains only its historical public shape", () => {
  const { debug } = projectSessionSnapshots(snapshotSource());
  assert.deepEqual(Object.keys(debug), ["state", "transitions", "detection", "packs", "decisions"]);
});

test("L7 effective base projection preserves producer-normalized branch names", () => {
  const releaseSnapshot = snapshotSource();
  releaseSnapshot.effectiveBase = "release/1.x";
  assert.equal(projectSessionSnapshots(releaseSnapshot).wire.effectiveBase, "release/1.x");
  assert.equal(projectSessionSnapshots(snapshotSource()).wire.effectiveBase, "main");
  const remoteQualifiedSnapshot = snapshotSource();
  remoteQualifiedSnapshot.effectiveBase = "origin/main";
  assert.equal(projectSessionSnapshots(remoteQualifiedSnapshot).wire.effectiveBase, "origin/main");
});
