"use strict";

// Guardrail: child-process-safe.js is the ONLY module allowed to import
// node:child_process. Every other runtime spawn must go through it so windowsHide
// can never be forgotten at a call site again (the bug this enforces: a burst of
// CMD windows on session start/park because a spawn site omitted windowsHide).
//
// This scans the runtime source tree and fails listing any offender. If you need
// to spawn a process, `require('./child-process-safe')` (or the right relative
// path) instead of child_process.
//
// Excluded (not server runtime, and intentionally allowed to use child_process
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

// The single module permitted to import child_process directly.
const ALLOWED = new Set([path.join(ROOT, "server", "child-process-safe.js")]);

const CHILD_PROCESS_REQUIRE = /require\(\s*['"](?:node:)?child_process['"]\s*\)/;

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

test("only child-process-safe.js imports child_process directly (all spawns go through it)", () => {
  const files = collectJsFiles(ROOT, []);
  // Sanity: the walk actually found the runtime tree (guards against an over-broad skip).
  assert.ok(files.length > 20, `expected to scan the runtime tree, only found ${files.length} files`);

  const offenders = [];
  for (const file of files) {
    if (ALLOWED.has(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    if (CHILD_PROCESS_REQUIRE.test(src)) offenders.push(path.relative(ROOT, file));
  }

  assert.deepEqual(
    offenders,
    [],
    `These modules must require('./child-process-safe') instead of child_process directly:\n  ${offenders.join("\n  ")}`,
  );
});

test("child-process-safe.js exists and exports the spawn surface", () => {
  const safe = require("../server/child-process-safe");
  for (const fn of ["execFile", "execFileSync", "execSync", "spawn", "hide"]) {
    assert.equal(typeof safe[fn], "function", `child-process-safe must export ${fn}`);
  }
});
