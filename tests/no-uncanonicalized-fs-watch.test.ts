// Every fs.watch path must pass canonicalizePath (shared/paths.ts): a Windows 8.3 short path aborts node in native code, and the 0.21.0 fix regressed once nothing enforced the seam.

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

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

// Immediate paren keeps fs.watchFile, `watchFn = fsNode.watch` defaults, and prose mentions out of the match.
const FS_WATCH_CALL = /\b(?:fs\w*\.watch|watchFn)\(/g;
const CANONICALIZED_ARG = /^canonicalizePath\(/;

// config-store's watchDir is path.dirname() of a path canonicalizePath resolved a few lines above.
const ALLOWED = new Map([
  [path.join(ROOT, "server", "config-store.js"), "watchDir"],
  [path.join(ROOT, "server", "config-store.ts"), "watchDir"],
]);

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

function lineNumberAt(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

test("every fs.watch target is canonicalized first (Windows 8.3 short paths abort libuv)", () => {
  const files = collectJsFiles(ROOT, []);
  assert.ok(files.length > 20, `expected to scan the runtime tree, only found ${files.length} files`);

  const offenders: string[] = [];
  let watchCallsSeen = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const allowedArg = ALLOWED.get(file);
    for (const match of src.matchAll(FS_WATCH_CALL)) {
      watchCallsSeen += 1;
      const argument = src.slice(match.index + match[0].length);
      if (CANONICALIZED_ARG.test(argument)) continue;
      if (allowedArg && argument.startsWith(`${allowedArg},`)) continue;
      offenders.push(`${path.relative(ROOT, file)}:${lineNumberAt(src, match.index)}`);
    }
  }

  assert.ok(watchCallsSeen >= 5, `expected to find the known fs.watch sites, found ${watchCallsSeen}`);

  assert.deepEqual(
    offenders,
    [],
    `These fs.watch targets must be wrapped in canonicalizePath (shared/paths.ts):\n  ${offenders.join("\n  ")}`,
  );
});
