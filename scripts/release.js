'use strict';

// ── Glissa release script ─────────────────────────────────────
// Publishes to npm, pushes to GitHub, tags, and creates a release.
// Usage: node scripts/release.js

const { execSync } = require('child_process');
const fs = require('fs');

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

const VERSION = require('../package.json').version;
const TAG = `v${VERSION}`;

console.log(`==> Releasing glissa ${TAG}\n`);

// 1. Ensure working tree is clean
const status = runCapture('git status --porcelain');
if (status) {
  console.error('ERROR: Working tree is dirty. Commit or stash changes first.');
  process.exit(1);
}

// 2. Build and verify dist
console.log('==> Building...');
run('npm run build');
fs.statSync('dist/index.html');

// 3. Publish to npm
console.log('\n==> Publishing to npm...');
run('npm publish');

// 4. Push commits to GitHub
console.log('\n==> Pushing to GitHub...');
run('git push');

// 5. Tag and push tag
console.log(`\n==> Tagging ${TAG}...`);
run(`git tag ${TAG}`);
run(`git push origin ${TAG}`);

// 6. Create GitHub release from CHANGELOG
console.log('\n==> Creating GitHub release...');
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const versionEscaped = VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(`^## \\[${versionEscaped}\\].*$\\n([\\s\\S]*?)(?=^## \\[|$)`, 'm');
const match = changelog.match(pattern);
const notes = match ? match[1].trim() : `Release ${TAG}`;

// Write notes to temp file to avoid shell escaping issues
const tmpFile = 'release-notes.tmp.md';
fs.writeFileSync(tmpFile, notes);
try {
  run(`gh release create ${TAG} --title "Glissa ${TAG}" --notes-file ${tmpFile}`);
} finally {
  fs.unlinkSync(tmpFile);
}

console.log(`\n==> Done! Published glissa@${VERSION} to npm and GitHub.`);
