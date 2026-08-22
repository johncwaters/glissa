"use strict";

// Guardrail: every path handed to fs.watch goes through canonicalizePath (shared/paths.js)
// first. libuv expands each reported event filename to its long form and asserts it still
// starts with the watched directory, so watching an unresolved Windows 8.3 short path
// (C:\Users\RUNNER~1\...) aborts the whole process from native code, past every try/catch
// (the bug this enforces: fixed once in 0.21.0, then reintroduced by two ingest sources
// that grew their own watchers, which turned Windows CI red on every run).
//
// This scans the runtime source tree and fails listing any offender. If you need to watch a
// directory, either wrap the argument in canonicalizePath or go through a helper that already
// does (detection/watch-debounce.js, server/pack-watch.js).
//
// Excluded (not server runtime): the test trees, dev scripts/, the browser bundle in public/,
// build output, and vendored/state dirs.

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

// The call shapes this repo actually uses: an fs-ish namespace's own `.watch(`, and the
// injectable `watchFn(` whose default is node's fs.watch. The paren must follow immediately,
// which is what keeps fs.watchFile, a bare `watchFn = fsNode.watch` default parameter, and
// prose like "a debounced fs.watch (fast, lossy)" out of the match.
const FS_WATCH_CALL = /\b(?:fs\w*\.watch|watchFn)\(/g;
const CANONICALIZED_ARG = /^canonicalizePath\(/;

// Call sites whose target is already canonical by construction, flagged here rather than
// silently excluded so a reviewer sees it was a deliberate call and not a gap in the scan.
const ALLOWED = new Map([
  // Watches path.dirname() of a path canonicalizePath already resolved a few lines above.
  [path.join(ROOT, "server", "config-store.js"), "watchDir"],
]);

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

function lineNumberAt(src, index) {
  return src.slice(0, index).split("\n").length;
}

test("every fs.watch target is canonicalized first (Windows 8.3 short paths abort libuv)", () => {
  const files = collectJsFiles(ROOT, []);
  // Sanity: the walk actually found the runtime tree (guards against an over-broad skip).
  assert.ok(files.length > 20, `expected to scan the runtime tree, only found ${files.length} files`);

  const offenders = [];
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

  // Sanity: a regex that stopped matching the real call sites would pass silently forever.
  assert.ok(watchCallsSeen >= 5, `expected to find the known fs.watch sites, found ${watchCallsSeen}`);

  assert.deepEqual(
    offenders,
    [],
    `These fs.watch targets must be wrapped in canonicalizePath (shared/paths.js):\n  ${offenders.join("\n  ")}`,
  );
});
