// Guardrail: child-process-safe.ts is the ONLY module allowed to import
// node:child_process. Every other runtime spawn must go through it so windowsHide
// can never be forgotten at a call site again (the bug this enforces: a burst of
// CMD windows on session start/park because a spawn site omitted windowsHide).
//
// This scans the runtime source tree and fails listing any offender. If you need
// to spawn a process, import './child-process-safe.ts' (or the right relative
// path) instead of child_process.
//
// Excluded (not server runtime, and intentionally allowed to use child_process
// directly): the test trees, dev scripts/ (manual terminal tools that own a
// console), the browser bundle in public/, build output, and vendored/state dirs.

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import * as childProcessSafe from "../server/child-process-safe.ts";

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

// The single module permitted to import child_process directly, plus the editor extension: it is
// installed OUTSIDE this package (server/visions-cli.ts packs it into a .vsix) and can no longer
// resolve anything inside it, so it carries windowsHide itself under the assertion below.
const EXTENSION = path.join(ROOT, "tools", "vscode-visions", "extension.ts");
const ALLOWED = new Set([
  path.join(ROOT, "server", "child-process-safe.js"),
  path.join(ROOT, "server", "child-process-safe.ts"),
  EXTENSION,
]);

const CHILD_PROCESS_REQUIRE =
  /require\(\s*['"](?:node:)?child_process['"]\s*\)|\bfrom\s*['"](?:node:)?child_process['"]|\bimport\s*\(\s*['"](?:node:)?child_process['"]\s*\)/;
// JSDoc/TS type references (`{import('node:child_process').ChildProcess}`, `import type`) are not runtime imports.
const TYPE_ONLY_LINE = /^\s*\*|^\s*\/\*\*|\bimport\s+type\b|@(?:type|typedef|param|property|returns)\b/;

function hasRuntimeChildProcessImport(src: string): boolean {
  return src.split("\n").some((line) => !TYPE_ONLY_LINE.test(line) && CHILD_PROCESS_REQUIRE.test(line));
}

function collectJsFiles(dir: string, acc: string[]): string[] {
  let entries: fs.Dirent[] = [];
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
    if (entry.isFile() && /\.(js|mjs|cjs|ts|mts|cts)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

test("only child-process-safe.ts imports child_process directly (all spawns go through it)", () => {
  const files = collectJsFiles(ROOT, []);
  // Sanity: the walk actually found the runtime tree (guards against an over-broad skip).
  assert.ok(files.length > 20, `expected to scan the runtime tree, only found ${files.length} files`);

  const offenders: string[] = [];
  for (const file of files) {
    if (ALLOWED.has(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    if (hasRuntimeChildProcessImport(src)) offenders.push(path.relative(ROOT, file));
  }

  assert.deepEqual(
    offenders,
    [],
    `These modules must import './child-process-safe.ts' instead of child_process directly:\n  ${offenders.join("\n  ")}`,
  );
});

test("child-process-safe.ts exists and exports the spawn surface", () => {
  const { execFile, execFileSync, execSync, spawn, hide } = childProcessSafe;
  for (const [name, fn] of Object.entries({ execFile, execFileSync, execSync, spawn, hide })) {
    assert.equal(typeof fn, "function", `child-process-safe must export ${name}`);
  }
});

test("the editor extension hides its own console window, since it cannot use the wrapper", () => {
  const source = fs.readFileSync(EXTENSION, "utf8");
  assert.match(source, /windowsHide: true/);
});
