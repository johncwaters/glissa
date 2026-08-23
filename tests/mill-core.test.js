'use strict';

// The pure Mill report assembler: what each pack row says, how a delivery is judged stale, how a
// drift check that could not run is reported, and which config keys are normalized into consumers.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_OUTPUT_ROWS, budgetPercent, buildMillReport, shortBuiltReason } = require('../server/core/mill-core');
const { MAX_INDEX_TOKENS } = require('../server/core/pack-core');

const VERSION = 'a'.repeat(64);
const OLD_VERSION = 'b'.repeat(64);

function validSpec(overrides = {}) {
  return {
    name: 'company-context',
    description: 'What the company is',
    sources: [{ path: 'sources/company-context' }],
    budgetTokens: 8000,
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    name: 'company-context',
    description: 'What the company is',
    version: VERSION,
    builtAt: '2026-08-20T10:00:00.000Z',
    tokenEstimate: 4000,
    budgetTokens: 8000,
    indexTokenEstimate: 300,
    rules: ['no emoji'],
    sources: [{ pattern: 'sources/company-context', files: [{ relPath: 'a.md' }, { relPath: 'b.md' }] }],
    skills: [{ dir: 'skills/x', name: 'x', files: [] }],
    outputs: [
      { relPath: 'CLAUDE.md', tokenEstimate: 300 },
      { relPath: '.claude/rules/01-company.md', tokenEstimate: 3700 },
    ],
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    ts: 1700000000000,
    requestId: 'mill-1',
    autoRebuild: true,
    distillerEnabled: false,
    watcherCount: 3,
    specs: [{ name: 'company-context', spec: validSpec(), manifest: manifest(), builtReason: null, distill: [] }],
    sessionRows: [],
    consumers: { projects: [], prReview: null, posthog: null },
    ...overrides,
  };
}

test('a built valid pack reports its version, budget share and content counts', () => {
  const report = buildMillReport(baseInput());
  assert.equal(report.type, 'mill-report');
  assert.equal(report.requestId, 'mill-1');
  assert.equal(report.ts, 1700000000000);
  assert.equal(report.autoRebuild, true);
  assert.equal(report.watcherCount, 3);
  assert.equal(report.error, null);

  const pack = report.packs[0];
  assert.equal(pack.name, 'company-context');
  assert.equal(pack.specValid, true);
  assert.deepEqual(pack.specErrors, []);
  assert.equal(pack.sourceCount, 1);
  assert.equal(pack.budgetTokens, 8000);
  assert.equal(pack.built.version, VERSION);
  assert.equal(pack.built.budgetPct, 50);
  assert.equal(pack.built.indexTokenCap, MAX_INDEX_TOKENS);
  assert.equal(pack.built.fileCount, 2, 'source files counted across every source group');
  assert.equal(pack.built.skillCount, 1);
  assert.equal(pack.built.ruleCount, 1);
  assert.equal(pack.built.outputs.length, 2);
  assert.equal(pack.built.moreOutputs, 0);
  assert.equal(pack.builtReason, null);
});

test('budgetPercent needs both sides, and a zero budget is not a division', () => {
  assert.equal(budgetPercent(4000, 8000), 50);
  assert.equal(budgetPercent(4000, 0), null);
  assert.equal(budgetPercent(null, 8000), null);
  assert.equal(budgetPercent(4000, null), null);
});

test('an unreadable spec is surfaced as invalid with its reason, and never crashes the report', () => {
  const report = buildMillReport(baseInput({
    specs: [{ name: 'broken', spec: null, specError: 'could not read spec: Unexpected token }', manifest: null, builtReason: 'not built', distill: [] }],
  }));
  const pack = report.packs[0];
  assert.equal(pack.specValid, false);
  assert.deepEqual(pack.specErrors, ['could not read spec: Unexpected token }']);
  assert.equal(pack.built, null);
  assert.equal(pack.builtReason, 'not built');
  assert.equal(report.totals.invalidSpecs, 1);
  assert.equal(report.totals.builtCount, 0);
});

test('a spec that parses but does not validate carries the validator errors', () => {
  const report = buildMillReport(baseInput({
    specs: [{ name: 'bad', spec: { name: 'bad', sources: [], budgetTokens: 100, nope: true }, manifest: null, distill: [] }],
  }));
  const pack = report.packs[0];
  assert.equal(pack.specValid, false);
  assert.ok(pack.specErrors.length > 0);
  assert.ok(pack.specErrors.some((error) => error.includes('nope')), 'the unknown key is named');
});

test('a delivery is stale only when the delivered version differs from a KNOWN built one', () => {
  const report = buildMillReport(baseInput({
    sessionRows: [
      { sessionId: 's1', sessionName: 'current', state: 'running', packs: [{ name: 'company-context', version: VERSION, reads: 4 }] },
      { sessionId: 's2', sessionName: 'behind', state: 'idle', packs: [{ name: 'company-context', version: OLD_VERSION, reads: 1, readsSinceNotice: 1 }] },
      { sessionId: 's3', sessionName: 'other pack', state: 'idle', packs: [{ name: 'elsewhere', version: VERSION, reads: 9 }] },
    ],
  }));
  const pack = report.packs[0];
  assert.deepEqual(pack.deliveredTo.map((d) => d.sessionId), ['s1', 's2']);
  assert.equal(pack.deliveredTo[0].stale, false);
  assert.equal(pack.deliveredTo[1].stale, true);
  assert.equal(pack.deliveredTo[1].readsSinceNotice, 1);
  assert.equal(pack.deliveredTo[0].readsSinceNotice, null, 'absent telemetry stays absent rather than reading as zero');
  assert.equal(pack.totalReads, 5);
  assert.equal(pack.staleDeliveries, 1);
  assert.equal(report.totals.staleDeliveries, 1);
  assert.equal(report.totals.totalReads, 5);
});

test('an unbuilt pack judges no delivery stale: an unknown version is not a mismatch', () => {
  const report = buildMillReport(baseInput({
    specs: [{ name: 'company-context', spec: validSpec(), manifest: null, builtReason: 'not built', distill: [] }],
    sessionRows: [{ sessionId: 's1', sessionName: 'a', state: 'running', packs: [{ name: 'company-context', version: OLD_VERSION, reads: 0 }] }],
  }));
  assert.equal(report.packs[0].deliveredTo[0].stale, null);
  assert.equal(report.totals.staleDeliveries, 0);
});

test('distill rows keep stale, current and could-not-check apart', () => {
  const report = buildMillReport(baseInput({
    specs: [{
      name: 'company-context',
      spec: validSpec(),
      manifest: manifest(),
      distill: [
        { output: 'sources/a.md', stale: true, reason: 'sources changed since the last distill' },
        { output: 'sources/b.md', stale: false, reason: null },
        { output: 'sources/c.md', stale: null, reason: 'EACCES: permission denied' },
      ],
    }],
  }));
  assert.deepEqual(report.packs[0].distill.map((row) => row.stale), [true, false, null]);
  assert.equal(report.totals.staleDistills, 1, 'a check that could not run is not counted as drift');
});

test('consumers are normalized through the spawn rule, and every rejection is reported once', () => {
  const report = buildMillReport(baseInput({
    consumers: {
      projects: [
        { name: 'glissa', packs: ['company-context', 'company-context'] },
        { name: 'other', packs: 'not-an-array' },
      ],
      prReview: ['company-context'],
      posthog: ['../escape'],
    },
  }));
  const pack = report.packs[0];
  assert.deepEqual(pack.consumers.projects, ['glissa']);
  assert.equal(pack.consumers.prReview, true);
  assert.equal(pack.consumers.posthog, false);
  assert.ok(report.configWarnings.some((w) => w.includes('project "glissa"') && w.includes('repeats')));
  assert.ok(report.configWarnings.some((w) => w.includes('project "other"') && w.includes('must be an array')));
  assert.ok(report.configWarnings.some((w) => w.includes('posthog.packs') && w.includes('not a valid pack name')));
});

test('a consumer naming a pack no spec defines is a warning, not a silent skip', () => {
  const report = buildMillReport(baseInput({
    consumers: { projects: [{ name: 'glissa', packs: ['ghost'] }], prReview: ['ghost'], posthog: null },
  }));
  assert.ok(report.configWarnings.some((w) => w === 'project "glissa" names pack "ghost", which has no spec'));
  assert.ok(report.configWarnings.some((w) => w === 'prReview.packs names pack "ghost", which has no spec'));
});

test('the outputs list is capped and the tail counted rather than shipped', () => {
  const outputs = Array.from({ length: MAX_OUTPUT_ROWS + 7 }, (_unused, index) => ({
    relPath: `.claude/rules/${index}.md`,
    tokenEstimate: 10,
  }));
  const report = buildMillReport(baseInput({
    specs: [{ name: 'company-context', spec: validSpec(), manifest: manifest({ outputs }), distill: [] }],
  }));
  assert.equal(report.packs[0].built.outputs.length, MAX_OUTPUT_ROWS);
  assert.equal(report.packs[0].built.moreOutputs, 7);
});

test('an empty mill reports zeros rather than throwing', () => {
  const report = buildMillReport({});
  assert.deepEqual(report.packs, []);
  assert.deepEqual(report.configWarnings, []);
  assert.deepEqual(report.totals, {
    packCount: 0, builtCount: 0, invalidSpecs: 0, staleDeliveries: 0, staleDistills: 0, totalReads: 0,
  });
  assert.equal(report.autoRebuild, false);
  assert.equal(report.watcherCount, null);
});

test('a spec whose name differs from its filename is invalid: the builder refuses it forever', () => {
  const report = buildMillReport(baseInput({
    specs: [{ name: 'company-context', spec: validSpec({ name: 'renamed' }), manifest: null, builtReason: 'not built (no dir)', distill: [] }],
  }));
  const pack = report.packs[0];
  assert.equal(pack.specValid, false);
  assert.ok(pack.specErrors.includes('spec name "renamed" does not match its filename'));
  assert.equal(report.totals.invalidSpecs, 1);
});

test('a spec whose name matches its filename keeps every other validator verdict', () => {
  const report = buildMillReport(baseInput());
  assert.equal(report.packs[0].specValid, true);
  assert.deepEqual(report.packs[0].specErrors, []);
});

test('the built skip reason is reported without the server filesystem in it', () => {
  assert.equal(shortBuiltReason('not built (no C:/Users/x/.glissa/packs/built/good/current)'), 'not built');
  assert.equal(shortBuiltReason('manifest.json missing or unreadable in /home/x/.glissa/packs/built/good/current'), 'manifest missing or unreadable');
  assert.equal(shortBuiltReason('not a valid pack name'), 'not a valid pack name');
  assert.equal(shortBuiltReason(null), null);

  const report = buildMillReport(baseInput({
    specs: [{ name: 'good', spec: validSpec({ name: 'good' }), manifest: null, builtReason: 'not built (no /home/x/.glissa/packs/built/good/current)', distill: [] }],
  }));
  assert.equal(report.packs[0].builtReason, 'not built');
  assert.ok(!JSON.stringify(report).includes('/home/x/'), 'no absolute path survives into the wire shape');
});

test('a manifest with no token estimate reports null rather than a confident zero', () => {
  const bare = manifest();
  delete bare.tokenEstimate;
  delete bare.indexTokenEstimate;
  const report = buildMillReport(baseInput({
    specs: [{ name: 'company-context', spec: validSpec(), manifest: bare, distill: [] }],
  }));
  assert.equal(report.packs[0].built.tokenEstimate, null);
  assert.equal(report.packs[0].built.indexTokenEstimate, null);
  assert.equal(report.packs[0].built.budgetPct, null);
  assert.equal(report.packs[0].built.fileCount, 2, 'counts still read as counts');
});
