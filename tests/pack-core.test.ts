import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  DELIVERY_SKIP_EMPTY,
  DELIVERY_SKIP_SELF_REFERENTIAL,
  INDEX_FILE,
  MANIFEST_FILE,
  MAX_INDEX_TOKENS,
  MAX_PACKS_PER_SESSION,
  applyPackDelta,
  consumedPackNames,
  decidePackDelivery,
  estimateTokens,
  isPackRelativePath,
  matchesGlob,
  normalizePackNames,
  packConsumerGroups,
  packConsumerSources,
  packTmpOwnerPid,
  packVariantProjects,
  planPackBuild,
  planPackVariants,
  projectVariantSlug,
  sameProjectRecords,
  shouldReclaimPackArtifact,
  sourceSlug,
  validatePackSpec,
  variantPackName,
} from '../server/core/pack-core.ts';
import { normalizeProjectTag, projectFileSlug } from '../server/core/memory-core.ts';

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

function sourceFile(relPath: string, content: string, sourceIndex = 0) {
  return { relPath, content, sourceIndex };
}

function outputByPath(plan: { outputs: { relPath: string; content: string }[] }, relPath: string) {
  return plan.outputs.find((file) => file.relPath === relPath) as { relPath: string; content: string };
}

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
  for (const name of ['house-rules', 'glissa_docs', 'pack.v2', 'A1']) {
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

test('skill directories apply relative-path and placeholder validation', () => {
  assert.equal(validatePackSpec(validSpec({ skills: [{ dir: '..' }] })).ok, false);
  assert.equal(validatePackSpec(validSpec({ skills: [{ dir: '{{unknownHome}}/skills' }] })).ok, false);
  assert.equal(validatePackSpec(validSpec({ skills: [{ dir: '{{glissaHome}}/memory/dist/current' }] })).ok, true);
});

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

test('estimateTokens rounds the chars-per-4 heuristic up', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens(null), 0);
});

test('sourceSlug names a rules file from the ordinal plus the last literal segment', () => {
  assert.equal(sourceSlug('sources/house-rules/*.md', 0), '01-house-rules');
  assert.equal(sourceSlug('docs/**/*.md', 1), '02-docs');
  assert.equal(sourceSlug('C:/notes/plan.md', 2), '03-plan');
  assert.equal(sourceSlug('*.md', 3), '04');
});

test('pack artifact ownership parses publisher temp dirs and reclaims only dead or old owners', () => {
  assert.equal(packTmpOwnerPid('tmp-1234-aabbcc'), 1234);
  assert.equal(packTmpOwnerPid('tmp-aabbcc'), null);
  assert.equal(shouldReclaimPackArtifact({
    timestampMs: 900,
    mtimeMs: 800,
    nowMs: 1000,
    isOwnerAlive: true,
    staleMs: 200,
  }), false);
  assert.equal(shouldReclaimPackArtifact({
    timestampMs: 900,
    mtimeMs: 800,
    nowMs: 1000,
    isOwnerAlive: false,
    staleMs: 200,
  }), true);
  assert.equal(shouldReclaimPackArtifact({
    timestampMs: null,
    mtimeMs: 700,
    nowMs: 1000,
    isOwnerAlive: true,
    staleMs: 200,
  }), true);
});

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

  assert.ok(rules.indexOf('alpha') < rules.indexOf('beta'));
});

test('the index carries no build stamp, so only content changes move the version', () => {
  const files = [sourceFile('sources/demo/a.md', 'alpha')];
  const early = planPackBuild(validSpec(), files, { builtAt: BUILT_AT });
  const later = planPackBuild(validSpec(), files, { builtAt: '2027-01-01T00:00:00.000Z' });

  assert.equal(early.manifest?.version, later.manifest?.version);
  assert.equal(outputByPath(early, INDEX_FILE).content, outputByPath(later, INDEX_FILE).content);
  assert.notEqual(early.manifest?.builtAt, later.manifest?.builtAt);
});

test('the same spec and the same content build byte-identically twice', () => {
  const files = [sourceFile('sources/demo/a.md', 'alpha'), sourceFile('sources/demo/b.md', 'beta')];
  const first = planPackBuild(validSpec(), files, { builtAt: BUILT_AT });
  const second = planPackBuild(validSpec(), [...files].reverse(), { builtAt: BUILT_AT });

  assert.deepEqual(first.outputs, second.outputs);
  assert.equal(first.manifest?.version, second.manifest?.version);
});

test('changed source content changes the version', () => {
  const before = planPackBuild(validSpec(), [sourceFile('sources/demo/a.md', 'alpha')], { builtAt: BUILT_AT });
  const after = planPackBuild(validSpec(), [sourceFile('sources/demo/a.md', 'alpha edited')], { builtAt: BUILT_AT });
  assert.notEqual(before.manifest?.version, after.manifest?.version);
});

test('an edited rule changes the version even though no source file moved', () => {
  const files = [sourceFile('sources/demo/a.md', 'alpha')];
  const before = planPackBuild(validSpec(), files, { builtAt: BUILT_AT });
  const after = planPackBuild(validSpec({ rules: ['keep it shorter'] }), files, { builtAt: BUILT_AT });
  assert.notEqual(before.manifest?.version, after.manifest?.version);
});

test('the manifest records per-source hashes, the budget verdict, and how tokens were counted', () => {
  const plan = planPackBuild(validSpec(), [sourceFile('sources/demo/a.md', 'alpha')], { builtAt: BUILT_AT });
  const manifest = plan.manifest;

  assert.equal(manifest?.name, 'demo');
  assert.equal(manifest?.builtAt, BUILT_AT);
  assert.equal(manifest?.budgetTokens, 1000);
  assert.equal(manifest?.budgetOk, true);
  assert.equal(manifest?.tokenEstimateMethod, 'chars-per-token-4');
  assert.equal(manifest?.sources.length, 1);
  assert.equal(manifest?.sources[0].pattern, 'sources/demo/*.md');
  assert.equal(manifest?.sources[0].files.length, 1);
  assert.match(manifest?.sources[0].files[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest?.tokenEstimate > 0);
});

test('the manifest is excluded from the version, so its own stamp cannot perturb it', () => {
  const plan = planPackBuild(validSpec(), [sourceFile('sources/demo/a.md', 'alpha')], { builtAt: BUILT_AT });
  assert.ok(!plan.manifest?.outputs.some((file) => file.relPath === MANIFEST_FILE));
  assert.equal(JSON.parse(outputByPath(plan, MANIFEST_FILE).content).version, plan.manifest?.version);
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
  assert.equal(plan.manifest?.skills[0].files.length, 2);
});

test('two skill dirs with the same basename cannot overwrite the same delivered path', () => {
  const spec = validSpec({
    skills: [{ dir: 'skills/alpha/shared' }, { dir: 'skills/beta/shared' }],
  });
  const plan = planPackBuild(spec, [
    sourceFile('sources/demo/a.md', 'alpha'),
    { relPath: 'SKILL.md', content: 'first skill', skillIndex: 0 },
    { relPath: 'SKILL.md', content: 'second skill', skillIndex: 1 },
  ], { builtAt: BUILT_AT });

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.outputs, []);
  assert.equal(plan.manifest, null);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /\.claude\/skills\/shared\/SKILL\.md/);
  assert.match(plan.errors[0], /skills\/alpha\/shared/);
  assert.match(plan.errors[0], /skills\/beta\/shared/);
});

test('duplicate delivered paths are detected after normalization', () => {
  const spec = validSpec({ skills: [{ dir: 'skills/voice-style' }] });
  const plan = planPackBuild(spec, [
    sourceFile('sources/demo/a.md', 'alpha'),
    { relPath: '../../rules/01-demo.md', content: 'overwrite', skillIndex: 0 },
  ], { builtAt: BUILT_AT });

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.outputs, []);
  assert.equal(plan.errors.some((error) => error.includes('.claude/rules/01-demo.md')), true);
});

test('a delivered path with an unfilled placeholder is rejected', () => {
  const spec = validSpec({ skills: [{ dir: 'skills/voice-style' }] });
  const plan = planPackBuild(spec, [
    sourceFile('sources/demo/a.md', 'alpha'),
    { relPath: '{{pending}}/SKILL.md', content: 'skill', skillIndex: 0 },
  ], { builtAt: BUILT_AT });

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.outputs, []);
  assert.equal(plan.errors.some((error) => error.includes('unfilled placeholder')), true);
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
  assert.deepEqual(normalizePackNames(['house-rules', 'crew-rules']).names, ['house-rules', 'crew-rules']);
  assert.deepEqual(normalizePackNames(['house-rules']).warnings, []);
});

test('normalizePackNames treats an absent list and a non-array as no packs', () => {
  assert.deepEqual(normalizePackNames(undefined), { names: [], warnings: [] });
  assert.deepEqual(normalizePackNames(null), { names: [], warnings: [] });
  const notAnArray = normalizePackNames('house-rules');
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

test('a source may declare optional, and only as a boolean', () => {
  assert.equal(validatePackSpec(validSpec({ sources: [{ path: 'derived/brief.md', optional: true }] })).ok, true);
  const wrongType = validatePackSpec(validSpec({ sources: [{ path: 'a.md', optional: 'yes' }] }));
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.errors.some((e) => e.includes('optional')));
});

test('an optional source that matched no file is skipped instead of failing the build', () => {
  const spec = validSpec({ sources: [{ glob: 'sources/demo/*.md' }, { path: 'derived/brief.md', optional: true }] });
  const plan = planPackBuild(spec, [sourceFile('sources/demo/a.md', 'alpha')], { builtAt: BUILT_AT });

  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.equal(plan.manifest?.sources.length, 1, 'only the group that matched files is in the manifest');
  assert.equal(outputByPath(plan, '.claude/rules/02-brief.md'), undefined);
});

test('a NON-optional source that matched no file is still a build error', () => {
  const spec = validSpec({ sources: [{ glob: 'sources/demo/*.md' }, { path: 'derived/brief.md' }] });
  const plan = planPackBuild(spec, [sourceFile('sources/demo/a.md', 'alpha')], { builtAt: BUILT_AT });

  assert.equal(plan.ok, false);
  assert.ok(plan.errors.some((e) => e.includes('matched no files')));
});

test('an optional source that DID match files is grouped like any other', () => {
  const spec = validSpec({ sources: [{ glob: 'sources/demo/*.md' }, { path: 'derived/brief.md', optional: true }] });
  const plan = planPackBuild(spec, [
    sourceFile('sources/demo/a.md', 'alpha'),
    sourceFile('derived/brief.md', 'the brief', 1),
  ], { builtAt: BUILT_AT });

  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.match(outputByPath(plan, '.claude/rules/02-brief.md').content, /the brief/);
});

function distillEntry(overrides = {}) {
  return {
    output: 'sources/demo/derived/brief.md',
    sources: [{ glob: 'sources/demo/*.md' }],
    instructions: 'summarize the sources',
    ...overrides,
  };
}

test('a well-formed distill entry validates', () => {
  assert.deepEqual(validatePackSpec(validSpec({ distill: [distillEntry()] })), { ok: true, errors: [] });
});

test('two distill entries naming the same output are rejected with both indexes', () => {
  const result = validatePackSpec(validSpec({
    distill: [
      distillEntry(),
      distillEntry({ output: 'sources\\demo\\derived\\brief.md' }),
    ],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.errors.includes('distill[1].output duplicates distill[0].output "sources\\demo\\derived\\brief.md"'), true);
});

test('a distill output that escapes the packs directory is rejected', () => {
  for (const output of ['../outside.md', 'a/../../outside.md', '/etc/passwd', 'C:/Windows/x.md', '\\\\server\\share.md', '']) {
    const result = validatePackSpec(validSpec({ distill: [distillEntry({ output })] }));
    assert.equal(result.ok, false, output);
    assert.ok(result.errors.some((e) => e.includes('output')), output);
  }
});

test('a distill entry needs sources and instructions, and rejects unknown keys', () => {
  const noSources = validatePackSpec(validSpec({ distill: [distillEntry({ sources: [] })] }));
  assert.equal(noSources.ok, false);
  assert.ok(noSources.errors.some((e) => e.includes('sources')));

  const noInstructions = validatePackSpec(validSpec({ distill: [distillEntry({ instructions: '  ' })] }));
  assert.equal(noInstructions.ok, false);
  assert.ok(noInstructions.errors.some((e) => e.includes('instructions')));

  const unknown = validatePackSpec(validSpec({ distill: [{ ...distillEntry(), model: 'opus' }] }));
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => e.includes('unknown key')));
});

test('distill sources are validated as ordinary source objects', () => {
  const bad = validatePackSpec(validSpec({ distill: [distillEntry({ sources: [{ path: 'a', glob: 'b' }] })] }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('distill[0].sources[0]')));
});

test('distill must be an array when present, and is optional', () => {
  assert.equal(validatePackSpec(validSpec({ distill: 'brief' })).ok, false);
  assert.equal(validatePackSpec(validSpec()).ok, true);
});

test('isPackRelativePath accepts a plain relative path and nothing that escapes', () => {
  assert.equal(isPackRelativePath('sources/glissa/derived/brief.md'), true);
  assert.equal(isPackRelativePath('brief.md'), true);
  for (const value of ['../brief.md', '/brief.md', 'C:/brief.md', '', null, 42, 'a/../../b.md']) {
    assert.equal(isPackRelativePath(value), false, String(value));
  }
});

test('consumedPackNames unions the projects and both ephemeral lanes, deduped and sorted', () => {
  assert.deepEqual(consumedPackNames({
    projects: [{ packs: ['zeta', 'alpha'] }, { packs: ['alpha'] }, {}],
    prReview: { packs: ['beta'] },
    posthog: { packs: ['alpha'] },
  }), ['alpha', 'beta', 'zeta']);
});

test('consumedPackNames drops what a spawn would drop, so the gate matches delivery', () => {
  assert.deepEqual(consumedPackNames({
    projects: [{ packs: ['../escape', 'good', 'good'] }, { packs: 'not-an-array' }],
  }), ['good']);
  assert.deepEqual(consumedPackNames({ projects: [{ packs: ['a', 'b', 'c', 'd', 'e'] }] }).length,
    MAX_PACKS_PER_SESSION, 'a list over the per-session cap contributes only what would be delivered');
});

test('a config naming no packs at all consumes nothing', () => {
  for (const config of [null, undefined, {}, { projects: [] }, { projects: [{ packs: [] }] }]) {
    assert.deepEqual(consumedPackNames(config), []);
  }
});

test('packConsumerSources lists one row per project plus one per lane', () => {
  const sources = packConsumerSources({
    projects: [{ id: 'p1', name: 'glissa', packs: ['a'] }, { path: 'C:/x' }],
    prReview: { packs: ['b'] },
    posthog: { packs: ['c'] },
  });
  assert.deepEqual(sources.map((s) => [s.kind, s.id, s.label]), [
    ['project', 'p1', 'glissa'],
    ['project', null, 'project'],
    ['prReview', null, 'prReview.packs'],
    ['posthog', null, 'posthog.packs'],
  ]);
});

test('consumedPackNames is derived from that one enumeration', () => {
  const config = { projects: [{ packs: ['zeta'] }], prReview: { packs: ['alpha'] }, posthog: { packs: ['zeta'] } };
  const union = new Set();
  for (const source of packConsumerSources(config)) {
    for (const name of normalizePackNames(source.packs).names) union.add(name);
  }
  assert.deepEqual(consumedPackNames(config), [...union].sort());
});

function projectRows(config: Record<string, unknown>) {
  return packConsumerGroups(config).filter((row) => row.kind === 'project');
}

test('two records on one path are ONE group: first id, first label, union of their packs', () => {
  const groups = projectRows({
    projects: [
      { id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['a'] },
      { id: 'p2', name: 'glissa (2)', path: 'C:/repo', packs: ['b', 'a'] },
    ],
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'p1', 'the primary id is the first record in config order');
  assert.equal(groups[0].label, 'glissa');
  assert.equal(groups[0].path, 'C:/repo');
  assert.deepEqual(groups[0].recordIds, ['p1', 'p2'], 'the write path fans a delta over every member');
  assert.deepEqual(groups[0].packs, ['a', 'b']);
});

test('distinct paths stay distinct, even sharing a basename', () => {
  const groups = projectRows({
    projects: [
      { id: 'p1', name: 'glissa', path: 'C:/work/glissa', packs: ['a'] },
      { id: 'p2', name: 'glissa fork', path: 'C:/forks/glissa', packs: ['b'] },
    ],
  });
  assert.deepEqual(groups.map((group) => group.id), ['p1', 'p2'], 'a basename is not an identity');
  assert.deepEqual(groups.map((group) => group.recordIds), [['p1'], ['p2']]);
});

test('a record with no usable path is its own group: nothing marks it as a sibling', () => {
  const groups = projectRows({ projects: [{ id: 'p1', name: 'a' }, { id: 'p2', name: 'b', path: '' }] });
  assert.deepEqual(groups.map((group) => group.id), ['p1', 'p2']);
  assert.deepEqual(groups.map((group) => group.path), [null, null]);
});

test('a lone member keeps its raw packs value, so a malformed one still warns downstream', () => {
  const groups = projectRows({ projects: [{ id: 'p1', name: 'a', path: 'C:/repo', packs: 'not-an-array' }] });
  assert.equal(groups[0].packs, 'not-an-array');
});

test('the lane rows pass through the grouping untouched', () => {
  const rows = packConsumerGroups({ projects: [], prReview: { packs: ['b'] }, posthog: { packs: ['c'] } });
  assert.deepEqual(rows.map((row) => [row.kind, row.label]), [
    ['prReview', 'prReview.packs'],
    ['posthog', 'posthog.packs'],
  ]);
});

test('sameProjectRecords names every card on one checkout, and only itself without a path', () => {
  const records = [
    { id: 'p1', path: 'C:/repo' },
    { id: 'p2', path: 'C:/repo' },
    { id: 'p3', path: 'C:/other' },
    { id: 'p4' },
  ];
  assert.deepEqual(sameProjectRecords(records, records[0]).map((r) => r.id), ['p1', 'p2']);
  assert.deepEqual(sameProjectRecords(records, records[2]).map((r) => r.id), ['p3']);
  assert.deepEqual(sameProjectRecords(records, records[3]).map((r) => r.id), ['p4']);
});

test('a delta adds and removes against the list it is given', () => {
  assert.deepEqual(applyPackDelta(['a'], 'b', true), { ok: true, packs: ['a', 'b'] });
  assert.deepEqual(applyPackDelta(['a', 'b'], 'b', false), { ok: true, packs: ['a'] });
  assert.deepEqual(applyPackDelta(null, 'b', true), { ok: true, packs: ['b'] });
  assert.deepEqual(applyPackDelta(['a'], 'b', false), { ok: true, packs: ['a'] }, 'removing an absent pack is a no-op');
});

test('delivering a pack already on the list is idempotent, not a duplicate', () => {
  assert.deepEqual(applyPackDelta(['a', 'b'], 'b', true), { ok: true, packs: ['a', 'b'] });
});

test('a delta past the cap is REFUSED, never silently dropped', () => {
  const full = ['a', 'b', 'c', 'd'];
  const result = applyPackDelta(full, 'e', true);
  assert.equal(result.ok, false);
  assert.match(result.error as string, /at most 4 packs/);

  assert.deepEqual(applyPackDelta(full, 'a', false), { ok: true, packs: ['b', 'c', 'd'] });
});

test('a delta keeps an over-cap hand-edited list intact when removing from it', () => {
  assert.deepEqual(applyPackDelta(['a', 'b', 'c', 'd', 'e'], 'a', false), { ok: true, packs: ['b', 'c', 'd', 'e'] });
});

test('a delta drops only what is genuinely unusable from the current list', () => {
  assert.deepEqual(applyPackDelta(['a', '../escape', 'a', 'b'], 'c', true), { ok: true, packs: ['a', 'b', 'c'] });
});

test('an oversized list is judged entry by entry and capped at the per-session limit', () => {
  const oversized = Array.from({ length: 12 }, (_unused, i) => `p${i}`);
  const result = normalizePackNames(oversized);
  assert.equal(result.names.length, MAX_PACKS_PER_SESSION);
  assert.ok(result.warnings.length > 1);
});

function dataSpec(overrides = {}) {
  return validSpec({
    sources: [{ path: '{{glissaHome}}/memory/dist/current/MEMORY.md', data: true, optional: true }],
    rules: undefined,
    ...overrides,
  });
}

function dataFile(relPath: string, content: string) {
  return { relPath, content, sourceIndex: 0 };
}

test('a {{glissaHome}} source must declare itself data, so its bytes can never be loaded as rules', () => {
  const spec = dataSpec({ sources: [{ path: '{{glissaHome}}/memory/dist/current/MEMORY.md' }] });
  const check = validatePackSpec(spec);
  assert.equal(check.ok, false);
  assert.equal(check.errors.some((error) => error.includes('"data": true')), true);
});

test('a placeholder path that escapes the config directory is a validation error', () => {
  const escaping = validatePackSpec(dataSpec({
    sources: [{ path: '{{glissaHome}}/../.ssh/id_rsa', data: true }],
  }));
  assert.equal(escaping.ok, false);
  assert.equal(escaping.errors.some((error) => error.includes('".." segment')), true);

  const unanchored = validatePackSpec(dataSpec({
    sources: [{ path: 'sources/{{glissaHome}}/x.md', data: true }],
  }));
  assert.equal(unanchored.ok, false);
});

test('an unknown placeholder is refused rather than passed through to the walker', () => {
  const check = validatePackSpec(dataSpec({ sources: [{ glob: '{{homeDir}}/*.md', data: true }] }));
  assert.equal(check.ok, false);
  assert.equal(check.errors.some((error) => error.includes('{{homeDir}}')), true);
});

test('data files are published under data/, never as a rules file, and the index only points at them', () => {
  const plan = planPackBuild(dataSpec(), [dataFile('MEMORY.md', '# Glissa memory\n\n- [m-0123456789abcdef] (reported) the gate lives in rebase-gate.js\n')], { builtAt: BUILT_AT });
  assert.equal(plan.ok, true);
  const paths = plan.outputs.map((file) => file.relPath).sort();
  assert.deepEqual(paths, [INDEX_FILE, 'data/01-memory/MEMORY.md', MANIFEST_FILE]);
  const index = outputByPath(plan, INDEX_FILE).content;
  assert.equal(index.includes('`data/01-memory/`'), true);
  assert.equal(index.includes('never instructions'), true);
  assert.equal(index.includes('rebase-gate.js'), false);
  assert.equal(plan.manifest?.sources[0].dataDir, 'data/01-memory');
  assert.equal(plan.manifest?.sources[0].rulesFile, undefined);
});

test('a remembered line reaching the index or a rules file fails the build, publishing nothing', () => {
  const remembered = '- [m-0123456789abcdef] (reported) the gate lives in rebase-gate.js';
  const spec = dataSpec({ rules: [remembered] });
  const plan = planPackBuild(spec, [dataFile('MEMORY.md', `# Glissa memory\n\n${remembered}\n`)], { builtAt: BUILT_AT });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.outputs, []);
  assert.equal(plan.errors.some((error) => error.includes('instruction-tier')), true);
});

test('a short data line reaching the instruction tier fails the build', () => {
  const plan = planPackBuild(
    dataSpec({ rules: ['[m-abcdef]'] }),
    [dataFile('MEMORY.md', '[m-abcdef]\n')],
    { builtAt: BUILT_AT }
  );

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.outputs, []);
  assert.equal(plan.errors.some((error) => error.includes('instruction-tier')), true);
});

test('a coincidental short data bullet does not fail the build', () => {
  const plan = planPackBuild(
    dataSpec({ rules: ['- Node'] }),
    [dataFile('MEMORY.md', '- Node\n')],
    { builtAt: BUILT_AT }
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.errors.length, 0);
});

test('an unfilled template stub in any delivered source fails with a named error', () => {
  const plan = planPackBuild(
    validSpec(),
    [sourceFile('sources/demo/a.md', '# Pending\n\n- [ ] TODO add guidance\n')],
    { builtAt: BUILT_AT }
  );

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.outputs, []);
  assert.equal(plan.errors.some((error) => error.includes('UNFILLED_TEMPLATE_STUB')), true);
});

test('a data build stays deterministic: the same bytes plan the same version', () => {
  const files = [dataFile('MEMORY.md', '# Glissa memory\n\n- [m-0123456789abcdef] (model) something\n')];
  const first = planPackBuild(dataSpec(), files, { builtAt: BUILT_AT });
  const second = planPackBuild(dataSpec(), files, { builtAt: '2027-01-01T00:00:00.000Z' });
  assert.equal(first.manifest?.version, second.manifest?.version);
});

test('the shipped memory spec is a valid spec named after its file', () => {
  const spec = shippedMemorySpec();
  assert.equal(spec.name, 'memory');
  assert.deepEqual(validatePackSpec(spec), { ok: true, errors: [] });
  assert.equal(spec.sources.every((source: { data?: unknown }) => source.data === true), true);
});

function shippedMemorySpec() {
  const specPath = path.join(import.meta.dirname, '..', 'packs', 'specs', 'memory.pack.json');
  return JSON.parse(fs.readFileSync(specPath, 'utf8'));
}

function variantSpec(overrides = {}) {
  return validSpec({
    perProjectVariants: true,
    rules: undefined,
    sources: [
      { path: '{{glissaHome}}/memory/dist/current/MEMORY.md', data: true, optional: true },
      { path: '{{glissaHome}}/memory/dist/current/projects/{{projectSlug}}.md', data: true },
    ],
    ...overrides,
  });
}

function project(id: string, projectPath: string, packs: string[]) {
  return { id, name: id, path: projectPath, packs };
}

test('the shipped memory spec declares per-project variants and a project-scoped source', () => {
  const spec = shippedMemorySpec();
  assert.equal(spec.perProjectVariants, true);
  const perProject = spec.sources.filter((source: { path?: unknown }) => String(source.path).includes('{{projectSlug}}'));
  assert.equal(perProject.length, 1);
  assert.equal(perProject[0].data, true);
  assert.equal(perProject[0].optional, true);
});

test('{{projectSlug}} is refused unless the spec declares perProjectVariants', () => {
  const check = validatePackSpec(variantSpec({ perProjectVariants: undefined }));
  assert.equal(check.ok, false);
  assert.equal(check.errors.some((error) => error.includes('perProjectVariants')), true);
});

test('a {{projectSlug}} source must declare itself data, like every other runtime path', () => {
  const spec = variantSpec({
    sources: [{ path: '{{glissaHome}}/memory/dist/current/projects/{{projectSlug}}.md' }],
  });
  const check = validatePackSpec(spec);
  assert.equal(check.ok, false);
  assert.equal(check.errors.some((error) => error.includes('"data": true')), true);
});

test('{{projectSlug}} may not anchor a pattern and may not carry a .. segment', () => {
  const anchored = validatePackSpec(variantSpec({
    sources: [{ path: '{{projectSlug}}/notes.md', data: true }],
  }));
  assert.equal(anchored.ok, false);
  assert.equal(anchored.errors.some((error) => error.includes('never the pattern')), true);

  const escaping = validatePackSpec(variantSpec({
    sources: [{ path: '{{glissaHome}}/memory/../../{{projectSlug}}.md', data: true }],
  }));
  assert.equal(escaping.ok, false);
  assert.equal(escaping.errors.some((error) => error.includes('".." segment')), true);
});

test('perProjectVariants without a project-scoped source is a spec error, not N identical packs', () => {
  const check = validatePackSpec(variantSpec({
    sources: [{ path: '{{glissaHome}}/memory/dist/current/MEMORY.md', data: true }],
  }));
  assert.equal(check.ok, false);
  assert.equal(check.errors.some((error) => error.includes('no source names')), true);
});

test('a distill entry may not name {{projectSlug}}: a distill lane has no variant to resolve it for', () => {
  const check = validatePackSpec(variantSpec({
    distill: [{
      output: 'sources/derived.md',
      sources: [{ path: '{{glissaHome}}/memory/dist/current/projects/{{projectSlug}}.md', data: true }],
      instructions: 'summarize',
    }],
  }));
  assert.equal(check.ok, false);
  assert.equal(check.errors.some((error) => error.includes('distill[0].sources[0] names "{{projectSlug}}"')), true);
});

test('the variant slug IS the memory projection slug, so a variant resolves its own project layer', () => {
  const slug = projectVariantSlug('/repos/a/glissa');
  assert.equal(slug, projectFileSlug(normalizeProjectTag('/repos/a/glissa')));
  assert.notEqual(slug, projectVariantSlug('/repos/b/glissa'));
  assert.equal(projectVariantSlug(''), null);
  assert.equal(variantPackName('memory', slug), `memory-${slug}`);
  assert.equal(variantPackName('memory', null), null);
});

test('a plain spec plans exactly one build of itself', () => {
  const plan = planPackVariants(validSpec(), [project('p1', '/repos/a', ['demo'])]);
  assert.equal(plan.isGroup, false);
  assert.equal(plan.builds.length, 1);
  assert.equal(plan.builds[0].name, 'demo');
  assert.equal(plan.builds[0].variant, null);
});

test('a group plans its base plus one flattened pack per CONSUMING project', () => {
  const projects = [
    project('p1', '/repos/a/glissa', ['demo']),
    project('p2', '/repos/b/other', ['demo']),
    project('p3', '/repos/c/nope', ['something-else']),
  ];
  const plan = planPackVariants(variantSpec(), projects);
  const slugA = projectVariantSlug('/repos/a/glissa');
  const slugB = projectVariantSlug('/repos/b/other');
  assert.deepEqual(plan.builds.map((build) => build.name), ['demo', `demo-${slugA}`, `demo-${slugB}`]);

  assert.equal(plan.builds[0].spec.sources.length, 1);
  assert.equal(plan.builds[0].spec.perProjectVariants, undefined);
  assert.equal(plan.builds[0].variant?.isGroupBase, true);

  const variant = plan.builds[1];
  assert.equal(String(variant.spec.sources[1].path).includes(String(slugA)), true);
  assert.equal(String(variant.spec.sources[1].path).includes('{{projectSlug}}'), false);
  assert.equal(variant.spec.sources[1].optional, true);
  assert.deepEqual(variant.variant?.foreignSlugs, [slugB]);
  assert.equal(variant.variant?.projectId, 'p1');
});

test('a consuming project with no usable path is warned about and delivered the base pack', () => {
  const plan = planPackVariants(variantSpec(), [project('p1', '', ['demo'])]);
  assert.deepEqual(plan.builds.map((build) => build.name), ['demo']);
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.warnings[0].includes('base "demo" pack'), true);
});

test('two projects on one path derive one variant, not two racing builds of the same name', () => {
  const plan = planPackVariants(variantSpec(), [
    project('p1', '/repos/a/glissa', ['demo']),
    project('p2', '/repos/a/glissa', ['demo']),
  ]);
  assert.equal(plan.builds.length, 2);
});

test('packVariantProjects normalizes each project pack list the way a spawn would', () => {
  const projects = packVariantProjects({
    projects: [{ id: 'p1', name: 'glissa', path: '/repos/a', packs: ['demo', 'demo', 7] }],
  });
  assert.deepEqual(projects, [{ id: 'p1', name: 'glissa', path: '/repos/a', packs: ['demo'] }]);
});

test('a variant carrying another project layer fails the build, publishing nothing', () => {
  const slugA = projectVariantSlug('/repos/a/glissa');
  const slugB = projectVariantSlug('/repos/b/other');
  const spec = validSpec({ name: `demo-${slugA}`, rules: undefined, sources: [{ glob: 'projects/*.md', data: true }] });
  const ours = { relPath: `${slugA}.md`, content: '- [m-0123456789abcdef] (model) ours\n', sourceIndex: 0 };
  const theirs = { relPath: `${slugB}.md`, content: '- [m-0123456789abcdef] (model) theirs\n', sourceIndex: 0 };
  const variant = { group: 'demo', isGroupBase: false, projectId: 'p1', projectSlug: slugA, foreignSlugs: [slugB] };

  const plan = planPackBuild(spec, [ours, theirs], { builtAt: BUILT_AT, variant });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.outputs, []);
  assert.equal(plan.errors.some((error) => error.includes(String(slugB))), true);

  assert.equal(planPackBuild(spec, [ours], { builtAt: BUILT_AT, variant }).ok, true);
});

test('a project-scoped source rejects an unknown project layer', () => {
  const slug = projectVariantSlug('/repos/a/glissa');
  const spec = validSpec({
    perProjectVariants: true,
    rules: undefined,
    sources: [{ glob: 'projects/*.md', exclude: [`projects/{{projectSlug}}.md`], data: true }],
  });
  const variants = planPackVariants(spec, [project('p1', '/repos/a/glissa', ['demo'])]);
  const variantBuild = variants.builds.find((build) => build.projectSlug === slug);
  const retiredSlug = 'retired-12345678';
  const files = [{ relPath: `${retiredSlug}.md`, sourcePath: `projects/${retiredSlug}.md`, content: 'retired\n', sourceIndex: 0 }];
  const plan = planPackBuild(variantBuild?.spec, files, { builtAt: BUILT_AT, variant: variantBuild?.variant });

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.outputs, []);
  assert.equal(plan.errors.some((error) => error.includes(retiredSlug) && error.includes(String(slug))), true);
});

test('the base build refuses any project layer at all: it is the pack every consumer shares', () => {
  const slugA = projectVariantSlug('/repos/a/glissa');
  const spec = validSpec({ rules: undefined, sources: [{ glob: 'projects/*.md', data: true }] });
  const files = [{ relPath: `${slugA}.md`, content: '- [m-0123456789abcdef] (model) ours\n', sourceIndex: 0 }];
  const plan = planPackBuild(spec, files, {
    builtAt: BUILT_AT,
    variant: { group: 'demo', isGroupBase: true, projectId: null, projectSlug: null, foreignSlugs: [slugA] },
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.errors.some((error) => error.includes(String(slugA))), true);
});

test('a group base manifest says so and a variant manifest names its group and project', () => {
  const spec = validSpec({ rules: undefined });
  const base = planPackBuild(spec, [sourceFile('a.md', 'x')], {
    builtAt: BUILT_AT,
    variant: { group: 'demo', isGroupBase: true, projectId: null, projectSlug: null, foreignSlugs: [] },
  });
  assert.equal(base.manifest?.perProjectVariants, true);
  assert.equal(base.manifest?.group, undefined);

  const variant = planPackBuild(validSpec({ name: 'demo-glissa-12345678', rules: undefined }), [sourceFile('a.md', 'x')], {
    builtAt: BUILT_AT,
    variant: { group: 'demo', isGroupBase: false, projectId: 'p1', projectSlug: 'glissa-12345678', foreignSlugs: [] },
  });
  assert.equal(variant.manifest?.perProjectVariants, undefined);
  assert.equal(variant.manifest?.group, 'demo');
  assert.equal(variant.manifest?.projectId, 'p1');
  assert.equal(variant.manifest?.projectSlug, 'glissa-12345678');
});

test('a plain build is byte-identical to the pre-variant one: no variant fields, same version', () => {
  const spec = validSpec();
  const files = [sourceFile('one.md', '# one\n')];
  const plan = planPackBuild(spec, files, { builtAt: BUILT_AT });
  assert.equal(plan.manifest?.perProjectVariants, undefined);
  assert.equal(plan.manifest?.group, undefined);
  assert.equal(plan.manifest?.projectSlug, undefined);
  assert.equal(plan.manifest?.version, planPackBuild(spec, files, { builtAt: BUILT_AT, variant: null }).manifest?.version);
});

function builtManifest(extra = {}) {
  return { name: 'demo', version: 'v1', sources: [{ pattern: 'sources/demo/*.md', files: [{ relPath: 'a.md' }] }], rules: [], skills: [], ...extra };
}

test('a pack whose sources live inside the consumer project is refused as self-referential', () => {
  const manifest = builtManifest({ sourceRoots: ['/home/dev/glissa/docs'] });
  const verdict = decidePackDelivery({ manifest, projectPath: '/home/dev/glissa' });
  assert.equal(verdict.deliver, false);
  assert.equal(verdict.reason, DELIVERY_SKIP_SELF_REFERENTIAL);
  assert.equal((verdict.detail ?? '').includes('/home/dev'), false, 'the detail reaches a paired phone, so it carries no path');
});

test('the project path itself, and a Windows-shaped one, count as inside it', () => {
  assert.equal(decidePackDelivery({ manifest: builtManifest({ sourceRoots: ['/repo'] }), projectPath: '/repo' }).deliver, false);
  const windows = decidePackDelivery({
    manifest: builtManifest({ sourceRoots: ['C:/Users/dev/repo/docs'] }),
    projectPath: 'C:\\Users\\dev\\repo',
  });
  assert.equal(windows.deliver, false, 'a backslash path is normalized before it is compared');
});

test('a sibling directory sharing a prefix is not inside the project', () => {
  const verdict = decidePackDelivery({ manifest: builtManifest({ sourceRoots: ['/home/dev/glissa-notes'] }), projectPath: '/home/dev/glissa' });
  assert.equal(verdict.deliver, true);
});

test('a packs-relative source root is judged against the packs dir it was recorded from', () => {
  const manifest = builtManifest({ sourceRoots: ['../docs'] });
  assert.equal(decidePackDelivery({ manifest, projectPath: '/home/dev/glissa', packsDir: '/home/dev/glissa/packs' }).deliver, false);
  assert.equal(decidePackDelivery({ manifest, projectPath: '/home/dev/other', packsDir: '/home/dev/glissa/packs' }).deliver, true);
});

test('a relative source root with no packs dir to resolve against decides nothing', () => {
  const manifest = builtManifest({ sourceRoots: ['../docs'] });
  assert.equal(decidePackDelivery({ manifest, projectPath: '/home/dev/glissa' }).deliver, true);
});

test('a legacy manifest that recorded no source roots still delivers', () => {
  assert.equal(decidePackDelivery({ manifest: builtManifest(), projectPath: '/home/dev/glissa' }).deliver, true);
});

test('a build carrying only the Glissa-authored index is refused as empty', () => {
  const verdict = decidePackDelivery({ manifest: builtManifest({ sources: [], rules: [], skills: [] }) });
  assert.equal(verdict.deliver, false);
  assert.equal(verdict.reason, DELIVERY_SKIP_EMPTY);
});

test('a source that matched nothing is empty, but any rule, skill or file is content', () => {
  const empty = { sources: [{ pattern: 'x', files: [] }], rules: [], skills: [] };
  assert.equal(decidePackDelivery({ manifest: empty }).reason, DELIVERY_SKIP_EMPTY);
  assert.equal(decidePackDelivery({ manifest: { ...empty, rules: ['one'] } }).deliver, true);
  assert.equal(decidePackDelivery({ manifest: { ...empty, skills: [{ name: 's' }] } }).deliver, true);
  assert.equal(decidePackDelivery({ manifest: { ...empty, sources: [{ pattern: 'x', files: [{ relPath: 'a.md' }] }] } }).deliver, true);
});

test('a manifest that recorded no sources array at all is unknown, not empty', () => {
  assert.equal(decidePackDelivery({ manifest: { name: 'demo', version: 'v1' } }).deliver, true);
  assert.equal(decidePackDelivery({ manifest: null }).deliver, true);
});
