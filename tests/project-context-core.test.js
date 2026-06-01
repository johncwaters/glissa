'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildContext,
  sanitize,
  cap,
  parsePackageJson,
  parseGitConfigOrigin,
  normalizeRepoUrl,
  extractH1,
  parseSiteConfig,
  renderSummary,
} = require('../teamlib/project-context-core');

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);

function hasForbidden(s) {
  return s.includes(EM_DASH) || s.includes(EN_DASH) || s.includes(ELLIPSIS);
}

// --- sanitize -------------------------------------------------------------

test('sanitize replaces em and en dashes with a hyphen', () => {
  const out = sanitize(`a ${EM_DASH} b ${EN_DASH} c`);
  assert.equal(hasForbidden(out), false);
  assert.equal(out, 'a - b - c');
});

test('sanitize replaces the ellipsis char with ASCII dots and collapses whitespace', () => {
  assert.equal(sanitize(`x${ELLIPSIS}`), 'x...');
  assert.equal(sanitize('  a   b \n c '), 'a b c');
});

test('sanitize tolerates empty/null', () => {
  assert.equal(sanitize(''), '');
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(undefined), '');
});

// --- cap ------------------------------------------------------------------

test('cap leaves short strings and truncates long ones with ASCII dots', () => {
  assert.equal(cap('abc', 10), 'abc');
  const out = cap('abcdefghij', 7);
  assert.equal(out, 'abcd...');
  assert.equal(out.length, 7);
  assert.equal(hasForbidden(out), false);
});

// --- parsePackageJson -----------------------------------------------------

test('parsePackageJson pulls identity fields and tolerates string/object repository + author', () => {
  const a = parsePackageJson(JSON.stringify({
    name: 'pkg', description: 'd', homepage: 'h',
    repository: { type: 'git', url: 'git+https://x/y.git' }, author: { name: 'Jane' },
  }));
  assert.equal(a.name, 'pkg');
  assert.equal(a.repoUrl, 'git+https://x/y.git');
  assert.equal(a.author, 'Jane');

  const b = parsePackageJson(JSON.stringify({ repository: 'owner/repo', author: 'Bob <b@x>' }));
  assert.equal(b.repoUrl, 'owner/repo');
  assert.equal(b.author, 'Bob <b@x>');
});

test('parsePackageJson returns {} for malformed or empty input', () => {
  assert.deepEqual(parsePackageJson('not json'), {});
  assert.deepEqual(parsePackageJson(''), {});
  assert.deepEqual(parsePackageJson('123'), {});
});

// --- parseGitConfigOrigin -------------------------------------------------

const MULTI_REMOTE = [
  '[core]',
  '\trepositoryformatversion = 0',
  '[remote "upstream"]',
  '\turl = https://github.com/upstream/repo.git',
  '\tfetch = +refs/heads/*:refs/remotes/upstream/*',
  '[remote "origin"]',
  '\turl = git@github.com:me/repo.git',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '[branch "main"]',
  '\tremote = origin',
].join('\n');

test('parseGitConfigOrigin picks origin even when another remote precedes it', () => {
  assert.equal(parseGitConfigOrigin(MULTI_REMOTE), 'git@github.com:me/repo.git');
});

test('parseGitConfigOrigin is CRLF-tolerant', () => {
  assert.equal(parseGitConfigOrigin(MULTI_REMOTE.replace(/\n/g, '\r\n')), 'git@github.com:me/repo.git');
});

test('parseGitConfigOrigin returns empty when there is no origin', () => {
  assert.equal(parseGitConfigOrigin('[remote "upstream"]\n\turl = https://x/y.git'), '');
  assert.equal(parseGitConfigOrigin(''), '');
});

// --- normalizeRepoUrl -----------------------------------------------------

test('normalizeRepoUrl normalizes git+https, scp, and plain https; idempotent', () => {
  assert.equal(normalizeRepoUrl('git+https://github.com/a/b.git'), 'https://github.com/a/b');
  assert.equal(normalizeRepoUrl('git@github.com:a/b.git'), 'https://github.com/a/b');
  assert.equal(normalizeRepoUrl('https://github.com/a/b'), 'https://github.com/a/b');
  const once = normalizeRepoUrl('git@github.com:a/b.git');
  assert.equal(normalizeRepoUrl(once), once); // idempotent
  assert.equal(normalizeRepoUrl(''), '');
});

test('normalizeRepoUrl leaves ssh:// scheme urls (does not misread as scp)', () => {
  assert.equal(normalizeRepoUrl('ssh://git@github.com/a/b'), 'ssh://git@github.com/a/b');
});

// --- extractH1 ------------------------------------------------------------

test('extractH1 returns the first ATX heading, trimming trailing hashes', () => {
  assert.equal(extractH1('# Hello World\n\nbody'), 'Hello World');
  assert.equal(extractH1('# Title #\r\nbody'), 'Title');
});

test('extractH1 falls back to the first non-badge non-empty line', () => {
  assert.equal(extractH1('![b](x)\n[![c](y)](z)\n\nProject Foo\n'), 'Project Foo');
});

test('extractH1 returns empty when there is no heading or only badges', () => {
  assert.equal(extractH1('![only](badge)'), '');
  assert.equal(extractH1(''), '');
});

// --- parseSiteConfig ------------------------------------------------------

test('parseSiteConfig reads YAML title/description, quoted or unquoted', () => {
  const r = parseSiteConfig('title: My Site\ndescription: "A great site"\n');
  assert.deepEqual(r, { name: 'My Site', description: 'A great site' });
});

test('parseSiteConfig reads TOML key = value form', () => {
  const r = parseSiteConfig("title = 'Hugo Site'\ndescription = desc here\n");
  assert.deepEqual(r, { name: 'Hugo Site', description: 'desc here' });
});

test('parseSiteConfig returns empties when keys are absent', () => {
  assert.deepEqual(parseSiteConfig('foo: bar'), { name: '', description: '' });
  assert.deepEqual(parseSiteConfig(''), { name: '', description: '' });
});

// --- renderSummary --------------------------------------------------------

test('renderSummary is deterministic and omits empty fields', () => {
  const fields = {
    name: 'Glissa', description: 'd', homepage: '', repoUrl: 'https://x/y', author: 'A', readmeTitle: '',
  };
  const a = renderSummary(fields);
  const b = renderSummary(fields);
  assert.equal(a, b);
  assert.match(a, /- Project: Glissa/);
  assert.equal(a.includes('Homepage'), false, 'empty homepage omitted');
});

test('renderSummary does not duplicate the title when Project falls back to readmeTitle', () => {
  // name empty -> Project line is sourced from readmeTitle; the README-title line must be suppressed.
  const out = renderSummary({ name: '', readmeTitle: 'OnlyReadme' });
  assert.match(out, /- Project: OnlyReadme/);
  assert.equal(out.includes('- README title:'), false, 'no duplicate README title line');
  // When they genuinely differ, both appear.
  const both = renderSummary({ name: 'PkgName', readmeTitle: 'Different Heading' });
  assert.match(both, /- Project: PkgName/);
  assert.match(both, /- README title: Different Heading/);
});

test('renderSummary returns empty string when every field is empty', () => {
  assert.equal(renderSummary({}), '');
  assert.equal(renderSummary({
    name: '', description: '', homepage: '', repoUrl: '', author: '', readmeTitle: '',
  }), '');
});

// --- buildContext ---------------------------------------------------------

test('buildContext prefers package.json over site config and git origin over repository.url', () => {
  const ctx = buildContext({
    packageJsonText: JSON.stringify({
      name: 'PkgName', description: 'pkg desc', repository: 'git+https://github.com/a/repo.git',
    }),
    siteConfigText: 'title: SiteName\ndescription: site desc',
    gitConfigText: '[remote "origin"]\n\turl = git@github.com:owner/canonical.git',
    readmeText: '# Readme Heading',
  });
  assert.equal(ctx.name, 'PkgName');
  assert.equal(ctx.description, 'pkg desc');
  assert.equal(ctx.repoUrl, 'https://github.com/owner/canonical', 'git origin wins');
  assert.equal(ctx.readmeTitle, 'Readme Heading');
});

test('buildContext backfills identity from site config when package.json is absent', () => {
  const ctx = buildContext({ siteConfigText: 'title: SiteName\ndescription: site desc' });
  assert.equal(ctx.name, 'SiteName');
  assert.equal(ctx.description, 'site desc');
});

test('buildContext falls back repoUrl to homepage when no git/repository', () => {
  const ctx = buildContext({ packageJsonText: JSON.stringify({ name: 'x', homepage: 'https://h/p' }) });
  assert.equal(ctx.repoUrl, 'https://h/p');
});

test('buildContext summary is byte-identical across two calls', () => {
  const input = {
    packageJsonText: JSON.stringify({ name: 'x', description: 'y', homepage: 'https://h' }),
    gitConfigText: '[remote "origin"]\n\turl = https://g/r.git',
    readmeText: '# Title',
  };
  assert.equal(buildContext(input).summary, buildContext(input).summary);
});

test('buildContext sanitizes dashes from scanned content (summary is ASCII-clean)', () => {
  const ctx = buildContext({
    packageJsonText: JSON.stringify({ name: 'x', description: `lean ${EM_DASH} mean ${EN_DASH} clean` }),
  });
  assert.equal(hasForbidden(ctx.description), false);
  assert.equal(hasForbidden(ctx.summary), false);
});

test('buildContext over empty input never throws and yields an empty summary', () => {
  const ctx = buildContext({});
  assert.equal(ctx.summary, '');
  assert.equal(ctx.name, '');
});
