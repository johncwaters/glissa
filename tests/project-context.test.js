'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanProjectContext } = require('../teamlib/project-context');

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-ctx-'));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

test('scanProjectContext surfaces name, normalized repo URL, and description for an npm repo', () => {
  const proj = tmpProject();
  try {
    write(proj, 'package.json', JSON.stringify({
      name: 'demo-app',
      description: 'A demo application',
      repository: { type: 'git', url: 'git+https://github.com/acme/demo-app.git' },
    }));
    write(proj, 'README.md', '# Demo App\n\nStuff.');
    write(proj, '.git/config', '[remote "origin"]\n\turl = git@github.com:acme/demo-app.git\n');
    const ctx = scanProjectContext(proj);
    assert.equal(ctx.name, 'demo-app');
    assert.equal(ctx.description, 'A demo application');
    assert.equal(ctx.repoUrl, 'https://github.com/acme/demo-app', 'git origin normalized + wins');
    assert.match(ctx.summary, /- Project: demo-app/);
    assert.match(ctx.summary, /- Repository: https:\/\/github\.com\/acme\/demo-app/);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('scanProjectContext backfills identity from _config.yml when there is no package.json', () => {
  const proj = tmpProject();
  try {
    write(proj, '_config.yml', 'title: My Jekyll Blog\ndescription: "thoughts and posts"\n');
    const ctx = scanProjectContext(proj);
    assert.equal(ctx.name, 'My Jekyll Blog');
    assert.equal(ctx.description, 'thoughts and posts');
    assert.match(ctx.summary, /- Project: My Jekyll Blog/);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('scanProjectContext is total: empty dir and missing path never throw and yield an empty summary', () => {
  const proj = tmpProject();
  try {
    const empty = scanProjectContext(proj);
    assert.equal(empty.summary, '');
    const missing = scanProjectContext(path.join(proj, 'does-not-exist'));
    assert.equal(missing.summary, '');
    assert.equal(scanProjectContext('').summary, '');
    assert.equal(scanProjectContext(null).summary, '');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('scanProjectContext never reads .env (off-allowlist secret never appears)', () => {
  const proj = tmpProject();
  try {
    const secret = 'glissa_secret_token_DO_NOT_LEAK_42';
    write(proj, '.env', `API_KEY=${secret}\n`);
    write(proj, 'package.json', JSON.stringify({ name: 'app', description: 'safe desc' }));
    const ctx = scanProjectContext(proj);
    assert.equal(ctx.summary.includes(secret), false, 'secret from .env must not leak into the summary');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('scanProjectContext does not walk node_modules (no recursive scan)', () => {
  const proj = tmpProject();
  try {
    write(proj, 'node_modules/foo/package.json', JSON.stringify({ name: 'SHOULD_NOT_APPEAR' }));
    const ctx = scanProjectContext(proj);
    assert.equal(ctx.summary.includes('SHOULD_NOT_APPEAR'), false, 'nested node_modules must not be read');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('scanProjectContext is deterministic: two scans of the same tree are byte-identical', () => {
  const proj = tmpProject();
  try {
    write(proj, 'package.json', JSON.stringify({ name: 'det', description: 'd', homepage: 'https://h/p' }));
    write(proj, 'README.md', '# Det\n');
    write(proj, '.git/config', '[remote "origin"]\n\turl = https://github.com/a/det.git\n');
    assert.equal(scanProjectContext(proj).summary, scanProjectContext(proj).summary);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('scanProjectContext sanitizes a README/description containing an em dash', () => {
  const proj = tmpProject();
  try {
    write(proj, 'package.json', JSON.stringify({
      name: 'app', description: `lean ${EM_DASH} mean ${EN_DASH} clean ${ELLIPSIS}`,
    }));
    const ctx = scanProjectContext(proj);
    const forbidden = ctx.summary.includes(EM_DASH) || ctx.summary.includes(EN_DASH)
      || ctx.summary.includes(ELLIPSIS);
    assert.equal(forbidden, false, 'summary must be free of em/en dashes and the ellipsis char');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
