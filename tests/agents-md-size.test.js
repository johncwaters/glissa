'use strict';

// Root loads into every session; a nested AGENTS.md loads only when that code is open, so the root cap is the strict one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const MAX_ROOT_BYTES = 10000;
const MAX_NESTED_BYTES = 18000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.glissa-worktrees']);
const CITATION_EXTENSIONS = /\.(js|mjs|cjs|ts|mts|cts|json|md|css|html|toml|yml|yaml|sh|ps1)$/;

function agentsMdFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) agentsMdFiles(path.join(dir, entry.name), found);
      continue;
    }
    if (entry.name === 'AGENTS.md') found.push(path.join(dir, entry.name));
  }
  return found;
}

// A citation names a path shape: has a separator, ends in a known extension (optionally plus a trailing `.symbol`).
function citedPaths(markdown) {
  const cited = new Set();
  for (const match of markdown.matchAll(/`([^`]+)`/g)) {
    const raw = match[1].trim();
    if (!raw.includes('/') || /[<>*: #]/.test(raw)) continue;
    if (/^([~/]|https?:|\.[A-Za-z])/.test(raw)) continue;
    if (CITATION_EXTENSIONS.test(raw)) { cited.add(raw); continue; }
    const withoutSymbol = raw.replace(/\.[A-Za-z_$][\w$]*$/, '');
    if (CITATION_EXTENSIONS.test(withoutSymbol)) cited.add(withoutSymbol);
  }
  return cited;
}

function resolvesFromAnyAncestor(citation, startDir) {
  if (fs.existsSync(path.join(REPO_ROOT, citation))) return true;
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.resolve(dir, citation))) return true;
    if (dir === REPO_ROOT) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

test('root AGENTS.md stays under the always-loaded byte budget', () => {
  const sizeBytes = fs.statSync(path.join(REPO_ROOT, 'AGENTS.md')).size;
  assert.ok(
    sizeBytes <= MAX_ROOT_BYTES,
    `AGENTS.md is ${sizeBytes} bytes, over the ${MAX_ROOT_BYTES} byte budget. It is loaded into every ` +
      'session: a subsystem rule belongs in that subsystem\'s own AGENTS.md, and what-prose belongs nowhere.'
  );
});

test('every nested AGENTS.md stays under its own budget, so growth cannot just move downhill', () => {
  const oversized = agentsMdFiles(REPO_ROOT)
    .filter((file) => file !== path.join(REPO_ROOT, 'AGENTS.md'))
    .map((file) => ({ file: path.relative(REPO_ROOT, file), sizeBytes: fs.statSync(file).size }))
    .filter((entry) => entry.sizeBytes > MAX_NESTED_BYTES);
  assert.deepEqual(
    oversized,
    [],
    `over the ${MAX_NESTED_BYTES} byte budget. Retire a rule whose code is gone or whose test now pins it, ` +
      'rather than trimming words off live ones.'
  );
});

// A citation resolving to nothing is the one machine-checkable sign a rule outlived its code.
test('every path an AGENTS.md cites still exists', () => {
  const broken = [];
  for (const file of agentsMdFiles(REPO_ROOT)) {
    const from = path.dirname(file);
    for (const citation of citedPaths(fs.readFileSync(file, 'utf8'))) {
      if (resolvesFromAnyAncestor(citation, from)) continue;
      broken.push(`${path.relative(REPO_ROOT, file)} cites ${citation}`);
    }
  }
  assert.deepEqual(broken, [], 'a citation resolving to nothing means the rule outlived its code: retire the rule or fix the path');
});
