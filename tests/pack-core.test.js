'use strict';

// The pure assembly stage of the context mill: spec validation, the glob matcher the walker drives,
// the token heuristic, and the build plan (outputs, manifest, hard budget gates, deterministic version).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INDEX_FILE,
  MANIFEST_FILE,
  MAX_INDEX_TOKENS,
  MAX_PACKS_PER_SESSION,
  estimateTokens,
  matchesGlob,
  normalizePackNames,
  planPackBuild,
  sourceSlug,
  validatePackSpec,
} = require('../server/core/pack-core');

const BUILT_AT = '2026-08-19T00:00:00.000Z';

function validSpec(overrides = {}) {
  return {
    name: 'demo',
    description: 'a demo pack',
    sources: [{ glob: 'sources/demo/*.md' }],
    rules: ['keep it short'],
    budgetTokens: 1000,
    ...overrides,
  };
}

function sourceFile(relPath, content, sourceIndex = 0) {
  return { relPath, content, sourceIndex };
}

function outputByPath(plan, relPath) {
  return plan.outputs.find((file) => file.relPath === relPath);
}

// ---------------------------------------------------------------------------
// validatePackSpec
// ---------------------------------------------------------------------------

test('a well-formed spec validates', () => {
  assert.deepEqual(validatePackSpec(validSpec()), { ok: true, errors: [] });
});

test('a spec without sources, name, or budget is rejected with one error each', () => {
  const result = validatePackSpec({});
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('name')));
  assert.ok(result.errors.some((e) => e.includes('sources')));
  assert.ok(result.errors.some((e) => e.includes('budgetTokens')));
});

test('a name that is not a plain path segment is rejected', () => {
  for (const name of ['../escape', 'has/slash', '', 'has space', '.hidden']) {
    assert.equal(validatePackSpec(validSpec({ name })).ok, false, name);
  }
  for (const name of ['company-context', 'glissa_docs', 'pack.v2', 'A1']) {
    assert.equal(validatePackSpec(validSpec({ name })).ok, true, name);
  }
});

test('a source must set exactly one of path or glob', () => {
  const both = validatePackSpec(validSpec({ sources: [{ path: 'a', glob: 'b' }] }));
  assert.equal(both.ok, false);
  assert.ok(both.errors.some((e) => e.includes('exactly one')));

  const neither = validatePackSpec(validSpec({ sources: [{}] }));
  assert.equal(neither.ok, false);

  assert.equal(validatePackSpec(validSpec({ sources: [{ path: 'docs' }] })).ok, true);
});

test('unknown keys are rejected rather than silently ignored', () => {
  const typo = validatePackSpec(validSpec({ budgetTokns: 10 }));
  assert.equal(typo.ok, false);
  assert.ok(typo.errors.some((e) => e.includes('budgetTokns')));

  const sourceTypo = validatePackSpec(validSpec({ sources: [{ glob: 'a/*.md', excludes: [] }] }));
  assert.equal(sourceTypo.ok, false);
  assert.ok(sourceTypo.errors.some((e) => e.includes('excludes')));
});

test('budgetTokens must be a positive integer', () => {
  for (const budgetTokens of [0, -1, 1.5, '1000', null]) {
    assert.equal(validatePackSpec(validSpec({ budgetTokens })).ok, false, String(budgetTokens));
  }
});

test('exclude and skills entries are shape-checked', () => {
  assert.equal(validatePackSpec(validSpec({ sources: [{ glob: 'a/*.md', exclude: 'nope' }] })).ok, false);
  assert.equal(validatePackSpec(validSpec({ sources: [{ glob: 'a/*.md', exclude: [''] }] })).ok, false);
  assert.equal(validatePackSpec(validSpec({ skills: [{ dir: '' }] })).ok, false);
  assert.equal(validatePackSpec(validSpec({ skills: [{ dir: 'skills/voice' }] })).ok, true);
});

// ---------------------------------------------------------------------------
// matchesGlob
// ---------------------------------------------------------------------------

test('a star stays inside one path segment', () => {
  assert.equal(matchesGlob('docs/*.md', 'docs/plan.md'), true);
  assert.equal(matchesGlob('docs/*.md', 'docs/archive/plan.md'), false);
  assert.equal(matchesGlob('docs/*.md', 'docs/plan.txt'), false);
  assert.equal(matchesGlob('docs/*.md', 'plan.md'), false);
});

test('a double star spans any number of segments, including zero', () => {
  assert.equal(matchesGlob('docs/**/*.md', 'docs/plan.md'), true);
  assert.equal(matchesGlob('docs/**/*.md', 'docs/a/b/c/plan.md'), true);
  assert.equal(matchesGlob('**/archive/**', 'docs/archive/old.md'), true);
  assert.equal(matchesGlob('**/archive/**', 'archive/old.md'), true);
  assert.equal(matchesGlob('**/archive/**', 'docs/current/old.md'), false);
});

test('a literal pattern matches only itself, and separator style does not matter', () => {
  assert.equal(matchesGlob('docs/plan.md', 'docs/plan.md'), true);
  assert.equal(matchesGlob('docs/plan.md', 'docs/plan.md.bak'), false);
  assert.equal(matchesGlob('C:/repo/docs/*.md', 'C:\\repo\\docs\\plan.md'), true);
  assert.equal(matchesGlob('docs\\*.md', 'docs/plan.md'), true);
});

test('matching ignores case, so a spec is reproducible off a Windows checkout', () => {
  assert.equal(matchesGlob('docs/*.md', 'Docs/PLAN.MD'), true);
});

test('regex metacharacters in a pattern are literal', () => {
  assert.equal(matchesGlob('docs/a.b.md', 'docs/a.b.md'), true);
  assert.equal(matchesGlob('docs/a.b.md', 'docs/axbxmd'), false);
  assert.equal(matchesGlob('docs/(x)+.md', 'docs/(x)+.md'), true);
});

test('a question mark matches exactly one character inside a segment', () => {
  assert.equal(matchesGlob('docs/v?.md', 'docs/v1.md'), true);
  assert.equal(matchesGlob('docs/v?.md', 'docs/v12.md'), false);
  assert.equal(matchesGlob('docs/v?.md', 'docs/v/1.md'), false);
});

test('non-string input never matches', () => {
  assert.equal(matchesGlob(null, 'docs/plan.md'), false);
  assert.equal(matchesGlob('docs/*.md', undefined), false);
});

// ---------------------------------------------------------------------------
// estimateTokens and sourceSlug
// ---------------------------------------------------------------------------

test('estimateTokens rounds the chars-per-4 heuristic up', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens(null), 0);
});

test('sourceSlug names a rules file from the ordinal plus the last literal segment', () => {
  assert.equal(sourceSlug('sources/company-context/*.md', 0), '01-company-context');
  assert.equal(sourceSlug('docs/**/*.md', 1), '02-docs');
  assert.equal(sourceSlug('C:/notes/plan.md', 2), '03-plan');
  assert.equal(sourceSlug('*.md', 3), '04');
});

// ---------------------------------------------------------------------------
// planPackBuild
// ---------------------------------------------------------------------------

test('a build emits a thin index, one rules file per source group, and a manifest', () => {
  const plan = planPackBuild(validSpec(), [
    sourceFile('sources/demo/b.md', '# B\n\nbeta\n'),
    sourceFile('sources/demo/a.md', '# A\n\nalpha\n'),
  ], { builtAt: BUILT_AT });

  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.deepEqual(
    plan.outputs.map((file) => file.relPath),
    ['.claude/rules/01-demo.md', INDEX_FILE, MANIFEST_FILE]
  );

  const index = outputByPath(plan, INDEX_FILE).content;
  assert.match(index, /^# demo/);
  assert.match(index, /a demo pack/);
  assert.match(index, /- keep it short/);
  assert.match(index, /`\.claude\/rules\/01-demo\.md`/);

  const rules = outputByPath(plan, '.claude/rules/01-demo.md').content;
  assert.match(rules, /alpha/);
  assert.match(rules, /beta/);
  // Sorted by relPath, so a.md leads regardless of the order the walker reported.
  assert.ok(rules.indexOf('alpha') < rules.indexOf('beta'));
});

test('the index carries no build stamp, so only content changes move the version', () => {
  const files = [sourceFile('sources/demo/a.md', 'alpha')];
  const early = planPackBuild(validSpec(), files, { builtAt: BUILT_AT });
  const later = planPackBuild(validSpec(), files, { builtAt: '2027-01-01T00:00:00.000Z' });

  assert.equal(early.manifest.version, later.manifest.version);
  assert.equal(outputByPath(early, INDEX_FILE).content, outputByPath(later, INDEX_FILE).content);
  assert.notEqual(early.manifest.builtAt, later.manifest.builtAt);
});

test('the same spec and the same content build byte-identically twice', () => {
  const files = [sourceFile('sources/demo/a.md', 'alpha'), sourceFile('sources/demo/b.md', 'beta')];
  const first = planPackBuild(validSpec(), files, { builtAt: BUILT_AT });
  const second = planPackBuild(validSpec(), [...files].reverse(), { builtAt: BUILT_AT });

  assert.deepEqual(first.outputs, second.outputs);
  assert.equal(first.manifest.version, second.manifest.version);
});

test('changed source content changes the version', () => {
  const before = planPackBuild(validSpec(), [sourceFile('sources/demo/a.md', 'alpha')], { builtAt: BUILT_AT });
  const after = planPackBuild(validSpec(), [sourceFile('sources/demo/a.md', 'alpha edited')], { builtAt: BUILT_AT });
  assert.notEqual(before.manifest.version, after.manifest.version);
});

test('an edited rule changes the version even though no source file moved', () => {
  const files = [sourceFile('sources/demo/a.md', 'alpha')];
  const before = planPackBuild(validSpec(), files, { builtAt: BUILT_AT });
  const after = planPackBuild(validSpec({ rules: ['keep it shorter'] }), files, { builtAt: BUILT_AT });
  assert.notEqual(before.manifest.version, after.manifest.version);
});

test('the manifest records per-source hashes, the budget verdict, and how tokens were counted', () => {
  const plan = planPackBuild(validSpec(), [sourceFile('sources/demo/a.md', 'alpha')], { builtAt: BUILT_AT });
  const manifest = plan.manifest;

  assert.equal(manifest.name, 'demo');
  assert.equal(manifest.builtAt, BUILT_AT);
  assert.equal(manifest.budgetTokens, 1000);
  assert.equal(manifest.budgetOk, true);
  assert.equal(manifest.tokenEstimateMethod, 'chars-per-token-4');
  assert.equal(manifest.sources.length, 1);
  assert.equal(manifest.sources[0].pattern, 'sources/demo/*.md');
  assert.equal(manifest.sources[0].files.length, 1);
  assert.match(manifest.sources[0].files[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.tokenEstimate > 0);
});

test('the manifest is excluded from the version, so its own stamp cannot perturb it', () => {
  const plan = planPackBuild(validSpec(), [sourceFile('sources/demo/a.md', 'alpha')], { builtAt: BUILT_AT });
  assert.ok(!plan.manifest.outputs.some((file) => file.relPath === MANIFEST_FILE));
  assert.equal(JSON.parse(outputByPath(plan, MANIFEST_FILE).content).version, plan.manifest.version);
});

test('going over budget fails the build and emits nothing', () => {
  const plan = planPackBuild(
    validSpec({ budgetTokens: 10 }),
    [sourceFile('sources/demo/a.md', 'x'.repeat(4000))],
    { builtAt: BUILT_AT }
  );

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.outputs, []);
  assert.equal(plan.manifest, null);
  assert.ok(plan.errors.some((e) => e.includes('over its 10 token budget')));
});

test('an index over the discovery cap fails the build even when the pack fits its budget', () => {
  const rules = Array.from({ length: 400 }, (_, i) => `rule number ${i} ${'y'.repeat(40)}`);
  const plan = planPackBuild(
    validSpec({ rules, budgetTokens: 1000000 }),
    [sourceFile('sources/demo/a.md', 'alpha')],
    { builtAt: BUILT_AT }
  );

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.outputs, []);
  assert.ok(plan.errors.some((e) => e.includes(`${MAX_INDEX_TOKENS} token index cap`)));
});

test('a source that matched nothing fails the build rather than shipping a hole', () => {
  const spec = validSpec({ sources: [{ glob: 'sources/demo/*.md' }, { glob: 'sources/missing/*.md' }] });
  const plan = planPackBuild(spec, [sourceFile('sources/demo/a.md', 'alpha')], { builtAt: BUILT_AT });

  assert.equal(plan.ok, false);
  assert.ok(plan.errors.some((e) => e.includes('sources[1]') && e.includes('matched no files')));
});

test('an invalid spec fails before any file is looked at', () => {
  const plan = planPackBuild({ name: 'demo' }, [], { builtAt: BUILT_AT });
  assert.equal(plan.ok, false);
  assert.equal(plan.manifest, null);
  assert.ok(plan.errors.some((e) => e.includes('sources')));
});

test('a file carrying neither a source nor a skill index is refused', () => {
  const plan = planPackBuild(validSpec(), [{ relPath: 'a.md', content: 'alpha' }], { builtAt: BUILT_AT });
  assert.equal(plan.ok, false);
  assert.ok(plan.errors.some((e) => e.includes('exactly one of sourceIndex or skillIndex')));
});

test('skill files are copied under .claude/skills/<dir name>, keeping their tree', () => {
  const spec = validSpec({ skills: [{ dir: 'skills/voice-style' }] });
  const plan = planPackBuild(spec, [
    sourceFile('sources/demo/a.md', 'alpha'),
    { relPath: 'SKILL.md', content: 'skill body', skillIndex: 0 },
    { relPath: 'references/tone.md', content: 'tone body', skillIndex: 0 },
  ], { builtAt: BUILT_AT });

  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.equal(outputByPath(plan, '.claude/skills/voice-style/SKILL.md').content, 'skill body');
  assert.equal(outputByPath(plan, '.claude/skills/voice-style/references/tone.md').content, 'tone body');
  assert.match(outputByPath(plan, INDEX_FILE).content, /`\.claude\/skills\/voice-style`/);
  assert.equal(plan.manifest.skills[0].files.length, 2);
});

test('a declared skill dir with no files fails the build', () => {
  const spec = validSpec({ skills: [{ dir: 'skills/empty' }] });
  const plan = planPackBuild(spec, [sourceFile('sources/demo/a.md', 'alpha')], { builtAt: BUILT_AT });
  assert.equal(plan.ok, false);
  assert.ok(plan.errors.some((e) => e.includes('skills[0]')));
});

test('two source groups get their own rules file, numbered in spec order', () => {
  const spec = validSpec({ sources: [{ glob: 'sources/demo/*.md' }, { glob: 'notes/**/*.md' }] });
  const plan = planPackBuild(spec, [
    sourceFile('sources/demo/a.md', 'alpha'),
    sourceFile('notes/deep/b.md', 'beta', 1),
  ], { builtAt: BUILT_AT });

  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.ok(outputByPath(plan, '.claude/rules/01-demo.md'));
  assert.ok(outputByPath(plan, '.claude/rules/02-notes.md'));
  assert.match(outputByPath(plan, '.claude/rules/02-notes.md').content, /beta/);
});

test('normalizePackNames keeps valid names in config order', () => {
  assert.deepEqual(normalizePackNames(['company-context', 'glissa']).names, ['company-context', 'glissa']);
  assert.deepEqual(normalizePackNames(['company-context']).warnings, []);
});

test('normalizePackNames treats an absent list and a non-array as no packs', () => {
  assert.deepEqual(normalizePackNames(undefined), { names: [], warnings: [] });
  assert.deepEqual(normalizePackNames(null), { names: [], warnings: [] });
  const notAnArray = normalizePackNames('company-context');
  assert.deepEqual(notAnArray.names, []);
  assert.equal(notAnArray.warnings.length, 1);
});

test('normalizePackNames drops non-string, path-escaping, and duplicate entries with a warning each', () => {
  const result = normalizePackNames(['ok', 42, '../escape', 'has space', '', 'ok']);
  assert.deepEqual(result.names, ['ok']);
  assert.equal(result.warnings.length, 5);
});

test('normalizePackNames caps the per-session pack count', () => {
  const many = Array.from({ length: MAX_PACKS_PER_SESSION + 2 }, (_, i) => `pack-${i}`);
  const result = normalizePackNames(many);
  assert.equal(result.names.length, MAX_PACKS_PER_SESSION);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((w) => w.includes('cap')));
});
