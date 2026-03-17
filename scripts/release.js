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

function hasCommand(cmd) {
  try {
    execSync(`where ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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

// 2. Check tag doesn't already exist
const existingTags = runCapture('git tag -l');
if (existingTags.split('\n').includes(TAG)) {
  console.error(`ERROR: Tag ${TAG} already exists. Bump the version in package.json first.`);
  process.exit(1);
}

// 3. Build and verify dist
console.log('==> Building...');
run('npm run build');
fs.statSync('dist/index.html');

// 4. Publish to npm (--ignore-scripts skips prepublishOnly to avoid double build)
console.log('\n==> Publishing to npm...');
run('npm publish --ignore-scripts');

// 5. Push commits to GitHub
console.log('\n==> Pushing to GitHub...');
run('git push');

// 6. Tag and push tag
console.log(`\n==> Tagging ${TAG}...`);
run(`git tag ${TAG}`);
run(`git push origin ${TAG}`);

// 7. Create GitHub release from CHANGELOG (optional — requires gh CLI)
if (hasCommand('gh')) {
  console.log('\n==> Creating GitHub release...');
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
  const versionEscaped = VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^## \\[${versionEscaped}\\].*$\\n([\\s\\S]*?)(?=^## \\[|$)`, 'm');
  const match = changelog.match(pattern);
  const notes = match ? match[1].trim() : `Release ${TAG}`;

  const tmpFile = 'release-notes.tmp.md';
  fs.writeFileSync(tmpFile, notes);
  try {
    run(`gh release create ${TAG} --title "Glissa ${TAG}" --notes-file ${tmpFile}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
} else {
  console.log('\n==> Skipping GitHub release (gh CLI not installed).');
  console.log(`   Create manually at: https://github.com/johncwaters/glissa/releases/new?tag=${TAG}`);
}

console.log(`\n==> Done! Published glissa@${VERSION} to npm and GitHub.`);
