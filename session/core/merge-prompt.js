"use strict";

// Pure builder for the "manual merge" handoff prompt. When a session's worktree merge PARKS (the
// rebase-then-FF onto the integration branch could not complete automatically), Glissa hands the
// conflict context back to the Claude agent running IN that worktree by pasting this prompt into its
// PTY (see Session.pasteMergePrompt). The agent then performs the merge it is best placed to do.
//
// Side-effect free and string-only so it is unit-testable without a Session or a PTY. The bracketed-
// paste wrapping and the actual PTY write live in sessions.js; this returns just the text.

// Plain-English "why it parked", keyed by the engine's park reason (teamlib/team-git.js).
function reasonText(reason, target) {
  switch (reason) {
    case "rebase-conflict":
      return `your commits overlap changes already on ${target}, so rebasing onto it hit conflicts.`;
    case "not-fast-forward":
      return `${target} advanced after this work started, so a clean fast-forward is no longer possible.`;
    case "uncommitted-changes":
      return "the worktree has uncommitted changes, which must be committed or discarded before it can merge.";
    case "no-target-branch":
    case "no-target":
      return `the integration branch ${target} does not exist.`;
    default:
      return reason
        ? `the merge could not complete automatically (${reason}).`
        : "the merge could not complete automatically.";
  }
}

// Build the handoff prompt. `conflicts` is the list of conflicting files (empty for a non-content park
// like a lost fast-forward). `branch`/`target`/`worktreeDir` describe the merge the agent must finish.
function buildMergePrompt({ branch, target, reason, conflicts = [], worktreeDir } = {}) {
  const tgt = target || "the integration branch";
  const br = branch || "this session's branch";
  const files = Array.isArray(conflicts) ? conflicts.filter(Boolean) : [];

  const lines = [];
  lines.push(
    `This session's work could not be merged back into ${tgt} automatically, so it needs a manual merge. ` +
      `You are running in the git worktree for branch "${br}", which was forked from ${tgt}.`,
  );
  lines.push("");
  lines.push(`Why it parked: ${reasonText(reason, tgt)}`);
  if (files.length) {
    lines.push("");
    lines.push("Conflicting files:");
    for (const f of files) lines.push(`  - ${f}`);
  }
  lines.push("");
  lines.push(`Glissa merges by rebasing "${br}" onto ${tgt} and then fast-forwarding ${tgt}. To unblock it:`);
  lines.push(`  1. From this worktree${worktreeDir ? ` (${worktreeDir})` : ""}, run: git rebase ${tgt}`);
  lines.push(
    `  2. Resolve the conflicts${files.length ? " in the files listed above" : ""}, ` +
      "then: git add the resolved files and git rebase --continue.",
  );
  lines.push(
    "  3. When the working tree is clean and rebased, tell me it is ready, or click Merge in the Review " +
      "panel: the merge will fast-forward.",
  );
  lines.push("");
  lines.push("Only rebase this session branch; do not force-push or rewrite any shared history.");
  return lines.join("\n");
}

module.exports = { buildMergePrompt };
