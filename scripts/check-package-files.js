'use strict';

// ── Package files validator ─────────────────────────────────────
// Traces all local require() calls from entry points (bin, main)
// and verifies every required file is listed in package.json "files".
//
// Limitations:
//   - Only detects string-literal requires: require('./foo')
//   - Dynamic requires like require('./' + name) are NOT detected
//   - Does not resolve directory requires to index.js
//
// Usage: node scripts/check-package-files.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 1. Collect entry points from bin and main
// ---------------------------------------------------------------------------

const entryPoints = [];

if (pkg.main) {
  entryPoints.push(pkg.main);
}

if (pkg.bin) {
  const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin;
  for (const p of Object.values(bins)) {
    entryPoints.push(p);
  }
}

if (entryPoints.length === 0) {
  console.error('ERROR: No entry points found in package.json (bin or main).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Recursively trace local requires
// ---------------------------------------------------------------------------

const REQUIRE_RE = /require\(['"](\.[^'"]+)['"]\)/g;
const visited = new Set();
const requiredFiles = new Set();

function resolveRequire(fromFile, target) {
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, target);

  // Skip non-local requires (package.json is auto-included by npm)
  const rel = path.relative(ROOT, resolved).replace(/\\/g, '/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel === 'package.json') return null;

  // Try with .js extension if no extension
  if (!path.extname(resolved)) {
    if (fs.existsSync(resolved + '.js')) {
      resolved = resolved + '.js';
    } else {
      return null;
    }
  }

  if (!fs.existsSync(resolved)) return null;

  return resolved;
}

function traceFile(filePath) {
  const abs = path.resolve(filePath);
  if (visited.has(abs)) return;
  visited.add(abs);

  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');

  // Skip files outside project, in node_modules, test, or scripts
  if (rel.startsWith('..') || rel.startsWith('node_modules/') ||
      rel.startsWith('test/') || rel.startsWith('scripts/')) {
    return;
  }

  requiredFiles.add(rel);

  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    console.error(`ERROR: Cannot read ${rel}`);
    process.exit(1);
  }

  let match;
  while ((match = REQUIRE_RE.exec(content)) !== null) {
    const resolved = resolveRequire(abs, match[1]);
    if (resolved) {
      traceFile(resolved);
    }
  }
}

for (const ep of entryPoints) {
  traceFile(path.join(ROOT, ep));
}

// ---------------------------------------------------------------------------
// 3. Resolve which files the "files" array covers
// ---------------------------------------------------------------------------

const filesArray = pkg.files || [];
const coveredFiles = new Set();
const negatedPaths = new Set();

// npm always includes these
const AUTO_INCLUDED = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];

for (const f of AUTO_INCLUDED) {
  coveredFiles.add(f);
}

for (const entry of filesArray) {
  if (entry.startsWith('!')) {
    negatedPaths.add(entry.slice(1));
    continue;
  }

  // Directory entry (ends with /)
  if (entry.endsWith('/')) {
    // Mark directory — we'll do prefix matching below
    coveredFiles.add('DIR:' + entry);
  } else {
    coveredFiles.add(entry);
  }
}

function isCovered(filePath) {
  if (negatedPaths.has(filePath)) return false;
  if (coveredFiles.has(filePath)) return true;

  // Check directory entries
  for (const entry of coveredFiles) {
    if (entry.startsWith('DIR:')) {
      const dir = entry.slice(4);
      if (filePath.startsWith(dir)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// 4. Compare and report
// ---------------------------------------------------------------------------

const missing = [];
for (const file of requiredFiles) {
  if (!isCovered(file)) {
    missing.push(file);
  }
}

if (missing.length > 0) {
  console.error('ERROR: Required files missing from package.json "files" array:\n');
  for (const f of missing.sort()) {
    console.error(`  - ${f}`);
  }
  console.error('\nAdd these to the "files" array in package.json before publishing.');
  process.exit(1);
}

console.log(`OK: All ${requiredFiles.size} required files are covered by the "files" array.`);
