"use strict";

// Guardrail: server/git-workspace.js is the ONLY module allowed to issue `git worktree`
// commands. Every other runtime module must go through it so worktree add/remove/prune
// stay serialized behind its mutex and junction-safe teardown (the bug this enforces:
// a bypassing caller racing git-workspace.js's own worktree add/remove and corrupting a
// concurrent run).
//
// This scans the runtime source tree and fails listing any offender. If you need to
// create, remove, or list a worktree, go through git-workspace.js instead of shelling to
// `git worktree` directly.
//
// Excluded (not server runtime, and intentionally allowed to use `git worktree`
// directly): the test trees, dev scripts/ (manual terminal tools that own a
// console), the browser bundle in public/, build output, and vendored/state dirs.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "public",
  "tests",
  "test",
  "scripts",
  ".git",
  ".omc",
  ".glissa",
  ".claude",
  ".glissa-worktrees",
]);

// The module permitted to issue `git worktree` directly.
const ALLOWED = new Set([
  path.join(ROOT, "server", "git-workspace.js"),
  // Pre-existing, read-only exception: cross-worktree conversation discovery needs to
  // enumerate a repo's linked worktrees (`git worktree list`) independent of the worktree
  // engine, and never adds/removes/prunes one. Flagged here rather than silently
  // excluded so a reviewer can see it was a deliberate call, not a gap in the scan.
  path.join(ROOT, "session", "core", "conversation-history.js"),
]);

// Matches a quoted 'worktree' literal as the FIRST element of an array literal, the
// shape every real git-arg-array call in this codebase uses: git(['worktree', 'add', ...]).
// Deliberately narrow: it does not match hyphenated event/state names ('worktree-changed',
// 'session-worktree-blocked'), unquoted identifiers (worktreeRoot, isWorktree), or prose
// in comments/docs describing worktrees, since none of those close the string right after
// the word "worktree".
const WORKTREE_GIT_ARG = /\[\s*['"]worktree['"]/;

function collectJsFiles(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc; // unreadable (e.g. a junction we do not care about)
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, acc);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}

test("only git-workspace.js (plus the documented read-only exception) issues `git worktree` directly", () => {
  const files = collectJsFiles(ROOT, []);
  // Sanity: the walk actually found the runtime tree (guards against an over-broad skip).
  assert.ok(files.length > 20, `expected to scan the runtime tree, only found ${files.length} files`);

  const offenders = [];
  for (const file of files) {
    if (ALLOWED.has(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    if (WORKTREE_GIT_ARG.test(src)) offenders.push(path.relative(ROOT, file));
  }

  assert.deepEqual(
    offenders,
    [],
    `These modules must go through server/git-workspace.js instead of issuing 'git worktree' directly:\n  ${offenders.join("\n  ")}`,
  );
});

test("git-workspace.js exists and exports the worktree workspace factories", () => {
  const gitWorkspace = require("../server/git-workspace");
  for (const fn of ["createGitWorkspace", "createGitWorkspaceSync"]) {
    assert.equal(typeof gitWorkspace[fn], "function", `git-workspace.js must export ${fn}`);
  }
});
