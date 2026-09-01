import { execSync } from 'node:child_process';
import type { ExecSyncOptions } from 'node:child_process';
import fs from 'node:fs';

import pkg from '../package.json' with { type: 'json' };

function run(cmd: string, opts: ExecSyncOptions = {}): void {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function runCapture(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function hasCommand(cmd: string): boolean {
  const probe = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
  try {
    execSync(probe, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const VERSION = pkg.version;
const TAG = `v${VERSION}`;

console.log(`==> Releasing glissa ${TAG}\n`);

const status = runCapture('git status --porcelain');
if (status) {
  console.error('ERROR: Working tree is dirty. Commit or stash changes first.');
  process.exit(1);
}

const existingTags = runCapture('git tag -l');
if (existingTags.split('\n').includes(TAG)) {
  console.error(`ERROR: Tag ${TAG} already exists. Bump the version in package.json first.`);
  process.exit(1);
}

console.log('==> Building...');
run('npm run build');
fs.statSync('dist/client/index.html');

console.log('\n==> Checking the tarball contents...');
const NOTICE_LINE = /^npm notice\s+[\d.]+\s*[kMG]?B\s+(.+)$/;
const packedFiles = runCapture('npm pack --dry-run 2>&1')
  .split('\n')
  .map((line) => line.trim().match(NOTICE_LINE))
  .filter((match): match is RegExpMatchArray => match !== null)
  .map((match) => match[1].trim());

if (!packedFiles.includes('dist/bin/glissa.js')) {
  console.error('ERROR: the tarball has no dist/bin/glissa.js, so the installed CLI would have nothing to run.');
  process.exit(1);
}
const rawSources = packedFiles.filter((file) => /\.[cm]?ts$/.test(file));
if (rawSources.length > 0) {
  console.error(`ERROR: the tarball ships raw TypeScript sources: ${rawSources.join(', ')}`);
  process.exit(1);
}
console.log(`   ${packedFiles.length} files, all built.`);

console.log('\n==> Pushing to GitHub...');
run('git push');

console.log(`\n==> Tagging ${TAG}...`);
run(`git tag -a ${TAG} -m "Glissa ${TAG}"`);
run(`git push origin ${TAG}`);

const hasGhCli = hasCommand('gh');
if (hasGhCli) {
  console.log('\n==> Creating GitHub release...');
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
  const versionEscaped = VERSION.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = new RegExp(String.raw`^## \[${versionEscaped}\].*\r?\n([\s\S]*?)(?=^## \[|$(?![\r\n]))`, 'm');
  const match = changelog.match(pattern);
  const notes = match ? match[1].trim() : `Release ${TAG}`;

  const tmpFile = 'release-notes.tmp.md';
  fs.writeFileSync(tmpFile, notes);
  try {
    run(`gh release create ${TAG} --title "Glissa ${TAG}" --notes-file ${tmpFile}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {  }
  }
}
if (!hasGhCli) {
  console.log('\n==> Skipping GitHub release (gh CLI not installed).');
  console.log(`   Create manually at: https://github.com/johncwaters/glissa/releases/new?tag=${TAG}`);
}

console.log(`\n==> Done! Tagged and pushed glissa ${TAG}.`);
