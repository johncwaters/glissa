
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import * as gitWorkspace from "../server/git-workspace.ts";

const ROOT = path.join(import.meta.dirname, "..");

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

const ALLOWED = new Set([
  path.join(ROOT, "server", "git-workspace.js"),
  path.join(ROOT, "server", "git-workspace.ts"),
  path.join(ROOT, "session", "core", "conversation-history.js"),
  path.join(ROOT, "session", "core", "conversation-history.ts"),
]);

const WORKTREE_GIT_ARG = /\[\s*['"]worktree['"]/;

function collectJsFiles(dir: string, acc: string[]): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, acc);
      continue;
    }
    if (entry.isFile() && /\.(js|mjs|cjs|ts|mts|cts)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

test("only git-workspace.ts (plus the documented read-only exception) issues `git worktree` directly", () => {
  const files = collectJsFiles(ROOT, []);
  assert.ok(files.length > 20, `expected to scan the runtime tree, only found ${files.length} files`);

  const offenders: string[] = [];
  for (const file of files) {
    if (ALLOWED.has(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    if (WORKTREE_GIT_ARG.test(src)) offenders.push(path.relative(ROOT, file));
  }

  assert.deepEqual(
    offenders,
    [],
    `These modules must go through server/git-workspace.ts instead of issuing 'git worktree' directly:\n  ${offenders.join("\n  ")}`,
  );
});

test("git-workspace.ts exists and exports the worktree workspace factories", () => {
  const { createGitWorkspace, createGitWorkspaceSync } = gitWorkspace;
  for (const [name, fn] of Object.entries({ createGitWorkspace, createGitWorkspaceSync })) {
    assert.equal(typeof fn, "function", `git-workspace.ts must export ${name}`);
  }
});
