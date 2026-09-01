import test from 'node:test';
import assert from 'node:assert/strict';
import type { MillPackRow } from '../server/core/mill-core.ts';

import { MAX_OUTPUT_ROWS, budgetPercent, buildMillReport, shortBuiltReason } from '../server/core/mill-core.ts';
import { MAX_INDEX_TOKENS, MAX_PACKS_PER_SESSION, packConsumerGroups } from '../server/core/pack-core.ts';

function sourcesFor({ projects = [], prReview = null, posthog = null } = {}) {
  return packConsumerGroups({
    projects,
    prReview: prReview ? { packs: prReview } : null,
    posthog: posthog ? { packs: posthog } : null,
  });
}

function laneKinds(pack: MillPackRow) {
  return (pack.consumers.lanes || []).map((lane) => lane.kind);
}

const VERSION = 'a'.repeat(64);
const OLD_VERSION = 'b'.repeat(64);

function validSpec(overrides = {}) {
  return {
    name: 'house-rules',
    description: 'What the company is',
    sources: [{ path: 'sources/house-rules' }],
    budgetTokens: 8000,
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    name: 'house-rules',
    description: 'What the company is',
    version: VERSION,
    builtAt: '2026-08-20T10:00:00.000Z',
    tokenEstimate: 4000,
    budgetTokens: 8000,
    indexTokenEstimate: 300,
    rules: ['no emoji'],
    sources: [{ pattern: 'sources/house-rules', files: [{ relPath: 'a.md' }, { relPath: 'b.md' }] }],
    skills: [{ dir: 'skills/x', name: 'x', files: [] }],
    outputs: [
      { relPath: 'CLAUDE.md', tokenEstimate: 300 },
      { relPath: '.claude/rules/01-company.md', tokenEstimate: 3700 },
    ],
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  const { consumers, ...rest } = overrides;
  return {
    ts: 1700000000000,
    requestId: 'mill-1',
    autoRebuild: true,
    distillerEnabled: false,
    watcherCount: 3,
    specs: [{ name: 'house-rules', spec: validSpec(), manifest: manifest(), builtReason: null, distill: [] }],
    sessionRows: [],
    consumerSources: sourcesFor(consumers || {}),
    ...rest,
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
  assert.equal(pack.name, 'house-rules');
  assert.equal(pack.specValid, true);
  assert.deepEqual(pack.specErrors, []);
  assert.equal(pack.sourceCount, 1);
  assert.equal(pack.budgetTokens, 8000);
  assert.equal(pack.built?.version, VERSION);
  assert.equal(pack.built?.budgetPct, 50);
  assert.equal(pack.built?.indexTokenCap, MAX_INDEX_TOKENS);
  assert.equal(pack.built?.fileCount, 2, 'source files counted across every source group');
  assert.equal(pack.built?.skillCount, 1);
  assert.equal(pack.built?.ruleCount, 1);
  assert.equal(pack.built?.outputs.length, 2);
  assert.equal(pack.built?.moreOutputs, 0);
  assert.equal(pack.builtReason, null);
  assert.equal(pack.measurement, null);
});

test('a named measurement joins its pack row without changing an unmeasured row', () => {
  const measurement = { deliveries: 4, measurableDeliveries: 3, openRate: 2 / 3 };
  const measured = buildMillReport(baseInput({ measurementByPack: { 'house-rules': measurement } }));
  assert.strictEqual(measured.packs[0].measurement, measurement);

  const unmeasured = buildMillReport(baseInput({ measurementByPack: { elsewhere: measurement } }));
  assert.equal(unmeasured.packs[0].measurement, null);
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
      { sessionId: 's1', sessionName: 'current', state: 'running', packs: [{ name: 'house-rules', version: VERSION }] },
      { sessionId: 's2', sessionName: 'behind', state: 'idle', packs: [{ name: 'house-rules', version: OLD_VERSION }] },
      { sessionId: 's3', sessionName: 'other pack', state: 'idle', packs: [{ name: 'elsewhere', version: VERSION }] },
    ],
  }));
  const pack = report.packs[0];
  assert.deepEqual(pack.deliveredTo.map((d) => d.project), ['current', 'behind']);
  assert.equal(pack.deliveredTo[0].stale, false);
  assert.equal(pack.deliveredTo[1].stale, true);
  assert.equal(pack.staleDeliveries, 1);
  assert.equal(report.totals.staleDeliveries, 1);
});

const SIBLING_PROJECTS = [
  { id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['house-rules'] },
  { id: 'p2', name: 'glissa (2)', path: 'C:/repo', packs: ['house-rules'] },
  { id: 'p3', name: 'other', path: 'C:/other', packs: ['house-rules'] },
];

test('two cards on one checkout are ONE delivery row, counted and summed', () => {
  const report = buildMillReport(baseInput({
    consumers: { projects: SIBLING_PROJECTS },
    sessionRows: [
      { sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'running', packs: [{ name: 'house-rules', version: VERSION }] },
      { sessionId: 's2', sessionName: 'glissa (2)', path: 'C:/repo', state: 'idle', packs: [{ name: 'house-rules', version: OLD_VERSION }] },
      { sessionId: 's3', sessionName: 'other', path: 'C:/other', state: 'running', packs: [{ name: 'house-rules', version: VERSION }] },
    ],
  }));
  const pack = report.packs[0];
  assert.deepEqual(pack.deliveredTo.map((delivery) => delivery.project), ['glissa', 'other']);
  const grouped = pack.deliveredTo[0];
  assert.equal(grouped.sessionCount, 2);
  assert.equal(grouped.state, null, 'two sessions in different states, so neither speaks for the project');
  assert.equal(grouped.version, null);
  assert.equal(grouped.stale, true, 'one session behind puts the project behind');
  assert.equal(grouped.staleSessions, 1);
  assert.equal(pack.staleDeliveries, 1, 'the total stays SESSIONS, which is what an operator restarts');
});

test('a grouped row keeps a state and a version its sessions agree on', () => {
  const report = buildMillReport(baseInput({
    consumers: { projects: SIBLING_PROJECTS },
    sessionRows: [
      { sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'running', packs: [{ name: 'house-rules', version: VERSION }] },
      { sessionId: 's2', sessionName: 'glissa (2)', path: 'C:/repo', state: 'running', packs: [{ name: 'house-rules', version: VERSION }] },
    ],
  }));
  const grouped = report.packs[0].deliveredTo[0];
  assert.equal(grouped.state, 'running');
  assert.equal(grouped.version, VERSION);
  assert.equal(grouped.stale, false);
  assert.equal(grouped.staleSessions, 0);
});

test('the delivery row is named by the project record, not by whichever card happens to be live', () => {
  const report = buildMillReport(baseInput({
    consumers: { projects: SIBLING_PROJECTS },
    sessionRows: [
      { sessionId: 's2', sessionName: 'glissa (2)', path: 'C:/repo', state: 'running', packs: [{ name: 'house-rules', version: VERSION }] },
    ],
  }));
  assert.equal(report.packs[0].deliveredTo[0].project, 'glissa');
});

test('a session whose path no project record names is still reported, under its own name', () => {
  const report = buildMillReport(baseInput({
    consumers: { projects: SIBLING_PROJECTS },
    sessionRows: [
      { sessionId: 's9', sessionName: 'ephemeral', path: 'C:/nowhere', state: 'running', packs: [{ name: 'house-rules', version: VERSION }] },
    ],
  }));
  assert.equal(report.packs[0].deliveredTo[0].project, 'ephemeral');
});

test('a session path never reaches the report: the tab renders on a paired phone too', () => {
  const report = buildMillReport(baseInput({
    consumers: { projects: SIBLING_PROJECTS },
    sessionRows: [
      { sessionId: 's1', sessionName: 'glissa', path: '/home/x/repo', state: 'running', packs: [{ name: 'house-rules', version: VERSION }] },
    ],
  }));
  assert.ok(!JSON.stringify(report).includes('/home/x/'), 'no server path survives into the wire shape');
});

test('sibling cards are one assignable project, with the packs either of them names', () => {
  const report = buildMillReport(baseInput({
    consumers: {
      projects: [
        { id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['house-rules'] },
        { id: 'p2', name: 'glissa (2)', path: 'C:/repo', packs: ['crew-rules'] },
        { id: 'p3', name: 'other', path: 'C:/other', packs: [] },
      ],
    },
  }));
  assert.deepEqual(report.projects, [
    { id: 'p1', name: 'glissa', packs: ['house-rules', 'crew-rules'] },
    { id: 'p3', name: 'other', packs: [] },
  ], 'the primary id addresses the whole project, and neither card is offered twice');
  assert.deepEqual(report.packs[0].consumers.projects, ['glissa'], 'and it names the project once');
});

test('a consuming project whose card has not spawned yet gets a pending delivery row', () => {
  const report = buildMillReport(baseInput({
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['house-rules'] }] },
    sessionRows: [
      { sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'DORMANT', packs: [] },
    ],
  }));
  const pending = report.packs[0].deliveredTo[0];
  assert.deepEqual(pending, {
    project: 'glissa',
    sessionCount: 1,
    state: 'DORMANT',
    version: null,
    stale: null,
    staleSessions: 0,
    pending: true,
  });
  assert.equal(report.totals.staleDeliveries, 0);
});

test('a delivered row is not pending, and a delivered project earns no second row', () => {
  const report = buildMillReport(baseInput({
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['house-rules'] }] },
    sessionRows: [
      { sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'running', packs: [{ name: 'house-rules', version: VERSION }] },
    ],
  }));
  const rows = report.packs[0].deliveredTo;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pending, false);
});

test('an ephemeral session neither counts toward nor states a pending row', () => {
  const report = buildMillReport(baseInput({
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['house-rules'] }] },
    sessionRows: [
      { sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'DORMANT', packs: [] },
      { sessionId: 'e1', sessionName: 'pr lane', path: 'C:/repo', state: 'running', ephemeral: true, packs: [] },
    ],
  }));
  const pending = report.packs[0].deliveredTo[0];
  assert.equal(pending.sessionCount, 1);
  assert.equal(pending.state, 'DORMANT');
});

test('a pending row never carries the project path onto the wire', () => {
  const report = buildMillReport(baseInput({
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: '/home/x/repo', packs: ['house-rules'] }] },
    sessionRows: [],
  }));
  assert.equal(report.packs[0].deliveredTo[0].pending, true);
  assert.ok(!JSON.stringify(report).includes('/home/x/'), 'no server path survives into the wire shape');
});

test('an empty build promises no pending delivery: the spawn would skip it', () => {
  const report = buildMillReport(baseInput({
    specs: [{ name: 'house-rules', spec: validSpec(), manifest: manifest({ sources: [], rules: [], skills: [] }), builtReason: null, distill: [] }],
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['house-rules'] }] },
    sessionRows: [{ sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'DORMANT', packs: [] }],
  }));
  assert.equal(report.packs[0].built?.empty, true);
  assert.deepEqual(report.packs[0].deliveredTo, []);
});

test('a pack that has never been built promises no pending delivery', () => {
  const report = buildMillReport(baseInput({
    specs: [{ name: 'house-rules', spec: validSpec(), manifest: null, builtReason: 'not built', distill: [] }],
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['house-rules'] }] },
    sessionRows: [{ sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'DORMANT', packs: [] }],
  }));
  assert.equal(report.packs[0].built, null);
  assert.deepEqual(report.packs[0].deliveredTo, []);
});

test('an invalid spec promises no pending delivery', () => {
  const report = buildMillReport(baseInput({
    specs: [{ name: 'house-rules', spec: validSpec({ sources: [] }), manifest: manifest(), builtReason: null, distill: [] }],
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['house-rules'] }] },
    sessionRows: [{ sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'DORMANT', packs: [] }],
  }));
  assert.equal(report.packs[0].specValid, false);
  assert.deepEqual(report.packs[0].deliveredTo, []);
});

test('a pack assembled from inside the consuming checkout promises no pending delivery', () => {
  const selfReferential = buildMillReport(baseInput({
    specs: [{ name: 'house-rules', spec: validSpec(), manifest: manifest({ sourceRoots: ['sources/house-rules'] }), builtReason: null, distill: [] }],
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['house-rules'] }] },
    sessionRows: [{ sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'DORMANT', packs: [] }],
    packsDir: 'C:/repo/packs',
  }));
  assert.deepEqual(selfReferential.packs[0].deliveredTo, []);

  const elsewhere = buildMillReport(baseInput({
    specs: [{ name: 'house-rules', spec: validSpec(), manifest: manifest({ sourceRoots: ['sources/house-rules'] }), builtReason: null, distill: [] }],
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['house-rules'] }] },
    sessionRows: [{ sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'DORMANT', packs: [] }],
    packsDir: 'C:/glissa/packs',
  }));
  assert.equal(elsewhere.packs[0].deliveredTo.length, 1);
  assert.equal(elsewhere.packs[0].deliveredTo[0].pending, true);
});

test('an unbuilt pack judges no delivery stale: an unknown version is not a mismatch', () => {
  const report = buildMillReport(baseInput({
    specs: [{ name: 'house-rules', spec: validSpec(), manifest: null, builtReason: 'not built', distill: [] }],
    sessionRows: [{ sessionId: 's1', sessionName: 'a', state: 'running', packs: [{ name: 'house-rules', version: OLD_VERSION }] }],
  }));
  assert.equal(report.packs[0].deliveredTo[0].stale, null);
  assert.equal(report.totals.staleDeliveries, 0);
});

test('distill rows keep stale, current and could-not-check apart', () => {
  const report = buildMillReport(baseInput({
    specs: [{
      name: 'house-rules',
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
        { name: 'glissa', packs: ['house-rules', 'house-rules'] },
        { name: 'other', packs: 'not-an-array' },
      ],
      prReview: ['house-rules'],
      posthog: ['../escape'],
    },
  }));
  const pack = report.packs[0];
  assert.deepEqual(pack.consumers.projects, ['glissa']);
  assert.deepEqual(laneKinds(pack), ['prReview'], 'only the lanes that actually name it');
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

test('a pack no project and no lane names reports hasConsumers false and counts as unconsumed', () => {
  const report = buildMillReport(baseInput({
    consumers: { projects: [{ id: 'p1', name: 'glissa', packs: [] }], prReview: null, posthog: null },
  }));
  assert.equal(report.packs[0].hasConsumers, false, 'nothing delivers it, so the mill skips it on purpose');
  assert.equal(report.totals.unconsumed, 1);
});

test('one consumer of any kind is enough for hasConsumers', () => {
  for (const consumers of [
    { projects: [{ id: 'p1', name: 'glissa', packs: ['house-rules'] }], prReview: null, posthog: null },
    { projects: [], prReview: ['house-rules'], posthog: null },
    { projects: [], prReview: null, posthog: ['house-rules'] },
  ]) {
    const report = buildMillReport(baseInput({ consumers }));
    assert.equal(report.packs[0].hasConsumers, true);
    assert.equal(report.totals.unconsumed, 0);
  }
});

test('the report carries each project id with the pack list a spawn would actually deliver', () => {
  const report = buildMillReport(baseInput({
    consumers: {
      projects: [
        { id: 'p1', name: 'glissa', packs: ['house-rules', 'house-rules', 'nope!'] },
        { id: 'p2', name: 'other', packs: null },
      ],
      prReview: null,
      posthog: null,
    },
  }));
  assert.deepEqual(report.projects, [
    { id: 'p1', name: 'glissa', packs: ['house-rules'] },
    { id: 'p2', name: 'other', packs: [] },
  ], 'the duplicate and the malformed entry are dropped, exactly as the spawn would drop them');
  assert.equal(report.maxPacksPerProject, MAX_PACKS_PER_SESSION, 'the cap ships so the tab cannot restate it wrong');
});

test('the outputs list is capped and the tail counted rather than shipped', () => {
  const outputs = Array.from({ length: MAX_OUTPUT_ROWS + 7 }, (_unused, index) => ({
    relPath: `.claude/rules/${index}.md`,
    tokenEstimate: 10,
  }));
  const report = buildMillReport(baseInput({
    specs: [{ name: 'house-rules', spec: validSpec(), manifest: manifest({ outputs }), distill: [] }],
  }));
  assert.equal(report.packs[0].built?.outputs.length, MAX_OUTPUT_ROWS);
  assert.equal(report.packs[0].built?.moreOutputs, 7);
});

test('an empty mill reports zeros rather than throwing', () => {
  const report = buildMillReport({});
  assert.deepEqual(report.packs, []);
  assert.deepEqual(report.configWarnings, []);
  assert.deepEqual(report.totals, {
    packCount: 0, variantCount: 0, builtCount: 0, unconsumed: 0, emptyBuilds: 0, invalidSpecs: 0, staleDeliveries: 0, staleDistills: 0,
  });
  assert.equal(report.autoRebuild, false);
  assert.equal(report.watcherCount, null);
  assert.deepEqual(report.projects, []);
});

test('a spec whose name differs from its filename is invalid: the builder refuses it forever', () => {
  const report = buildMillReport(baseInput({
    specs: [{ name: 'house-rules', spec: validSpec({ name: 'renamed' }), manifest: null, builtReason: 'not built (no dir)', distill: [] }],
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
  const bare = manifest() as Record<string, unknown>;
  delete bare.tokenEstimate;
  delete bare.indexTokenEstimate;
  const report = buildMillReport(baseInput({
    specs: [{ name: 'house-rules', spec: validSpec(), manifest: bare, distill: [] }],
  }));
  assert.equal(report.packs[0].built?.tokenEstimate, null);
  assert.equal(report.packs[0].built?.indexTokenEstimate, null);
  assert.equal(report.packs[0].built?.budgetPct, null);
  assert.equal(report.packs[0].built?.fileCount, 2, 'counts still read as counts');
});

const GROUP_SPEC = validSpec({ name: 'memory', perProjectVariants: true, sources: [{ path: '{{glissaHome}}/m/{{projectSlug}}.md', data: true }] });

function groupEntry(manifestOverrides = {}) {
  return { name: 'memory', spec: GROUP_SPEC, manifest: manifest({ name: 'memory', ...manifestOverrides }), builtReason: null, distill: [] };
}

function unbuiltVariantEntry() {
  return {
    name: 'memory-glissa-12345678',
    spec: GROUP_SPEC,
    group: 'memory',
    variantProject: { id: 'p1', label: 'glissa' },
    manifest: null,
    builtReason: 'not built',
    distill: [],
  };
}

function variantInput(overrides = {}) {
  return baseInput({
    specs: [
      groupEntry(),
      {
        name: 'memory-glissa-12345678',
        spec: GROUP_SPEC,
        group: 'memory',
        variantProject: { id: 'p1', label: 'glissa' },
        manifest: manifest({ name: 'memory-glissa-12345678', version: OLD_VERSION }),
        builtReason: null,
        distill: [],
      },
    ],
    consumers: { projects: [{ id: 'p1', name: 'glissa', packs: ['memory'] }] },
    ...overrides,
  });
}

test('a derived pack is its own row, naming the group it came from and the project it is for', () => {
  const report = buildMillReport(variantInput());
  const [group, variant] = report.packs;

  assert.equal(group.group, null, 'a group is the base build, not a variant of itself');
  assert.equal(variant.group, 'memory');
  assert.equal(variant.projectId, 'p1');
  assert.equal(variant.name, 'memory-glissa-12345678');
  assert.equal(variant.built?.version, OLD_VERSION);
  assert.equal(report.totals.variantCount, 1);
});

test('a variant consumer is exactly its project, and the assignment stays on the group', () => {
  const report = buildMillReport(variantInput());
  const [group, variant] = report.packs;

  assert.deepEqual(group.consumers.projects, ['glissa']);
  assert.deepEqual(variant.consumers.projects, ['glissa']);
  assert.deepEqual(variant.consumers.lanes, []);
  assert.equal(variant.hasConsumers, true);
  assert.deepEqual(report.projects, [{ id: 'p1', name: 'glissa', packs: ['memory'] }]);
});

test('a variant is not judged against its group name: it never counts as a spec a consumer may name', () => {
  const report = buildMillReport(variantInput({
    consumers: { projects: [{ id: 'p1', name: 'glissa', packs: ['memory-glissa-12345678'] }] },
  }));
  assert.equal(report.configWarnings.some((warning) => warning.includes('has no spec')), true);
});

test('a variant row is valid even though its name differs from the spec filename', () => {
  const report = buildMillReport(variantInput());
  assert.equal(report.packs[1].specValid, true);
  assert.deepEqual(report.packs[1].specErrors, []);
});

test('a delivery of a variant is joined onto the variant row, not its group', () => {
  const report = buildMillReport(variantInput({
    sessionRows: [{
      sessionId: 's1',
      sessionName: 'glissa',
      state: 'RUNNING',
      packs: [{ name: 'memory-glissa-12345678', version: VERSION }],
    }],
  }));
  const [group, variant] = report.packs;
  assert.deepEqual(group.deliveredTo, []);
  assert.equal(variant.deliveredTo.length, 1);
  assert.equal(variant.deliveredTo[0].stale, true, 'the delivered version is compared against the VARIANT build');
});

test('an undelivered variant pends on the variant row, and its group row stays empty', () => {
  const report = buildMillReport(variantInput({
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['memory'] }] },
    sessionRows: [{ sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'DORMANT', packs: [] }],
  }));
  const [group, variant] = report.packs;
  assert.deepEqual(group.deliveredTo, []);
  assert.equal(variant.deliveredTo.length, 1);
  assert.equal(variant.deliveredTo[0].pending, true);
  assert.equal(variant.deliveredTo[0].project, 'glissa');
});

test('a project whose variant is unbuilt pends on the group row: the spawn hands it the base pack', () => {
  const report = buildMillReport(variantInput({
    specs: [groupEntry(), unbuiltVariantEntry()],
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['memory'] }] },
    sessionRows: [{ sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'DORMANT', packs: [] }],
  }));
  const [group, variant] = report.packs;
  assert.equal(group.deliveredTo.length, 1);
  assert.equal(group.deliveredTo[0].pending, true);
  assert.equal(group.deliveredTo[0].project, 'glissa');
  assert.deepEqual(variant.deliveredTo, []);
});

test('a project with no variant row at all pends on the group row', () => {
  const report = buildMillReport(variantInput({
    specs: [groupEntry()],
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['memory'] }] },
    sessionRows: [{ sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'DORMANT', packs: [] }],
  }));
  assert.equal(report.packs[0].deliveredTo.length, 1);
  assert.equal(report.packs[0].deliveredTo[0].pending, true);
});

test('an empty base build promises no pending delivery, even where the variant is unbuilt', () => {
  const report = buildMillReport(variantInput({
    specs: [groupEntry({ sources: [], rules: [], skills: [] }), unbuiltVariantEntry()],
    consumers: { projects: [{ id: 'p1', name: 'glissa', path: 'C:/repo', packs: ['memory'] }] },
    sessionRows: [{ sessionId: 's1', sessionName: 'glissa', path: 'C:/repo', state: 'DORMANT', packs: [] }],
  }));
  const [group, variant] = report.packs;
  assert.equal(group.built?.empty, true);
  assert.deepEqual(group.deliveredTo, []);
  assert.deepEqual(variant.deliveredTo, []);
});

test('a build carrying only its own index reads as empty, and the totals count it', () => {
  const report = buildMillReport(baseInput({
    specs: [{ name: 'hollow', spec: validSpec({ name: 'hollow' }), manifest: manifest({ name: 'hollow', sources: [], rules: [], skills: [] }), distill: [] }],
  }));
  assert.equal(report.packs[0].built?.empty, true);
  assert.equal(report.totals.emptyBuilds, 1);
});

test('a build with content is not empty', () => {
  const report = buildMillReport(baseInput({ specs: [{ name: 'house-rules', spec: validSpec(), manifest: manifest(), distill: [] }] }));
  assert.equal(report.packs[0].built?.empty, false);
  assert.equal(report.totals.emptyBuilds, 0);
});
