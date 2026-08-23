'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// mill-view-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/mill-view-core.mjs');

const VERSION = 'abcdef0123456789';

function pack(overrides = {}) {
  return {
    name: 'company-context',
    description: '',
    specValid: true,
    specErrors: [],
    sourceCount: 1,
    budgetTokens: 8000,
    built: {
      version: VERSION,
      builtAt: '2026-08-20T10:00:00.000Z',
      tokenEstimate: 4000,
      budgetTokens: 8000,
      budgetPct: 50,
      indexTokenEstimate: 300,
      indexTokenCap: 1200,
      fileCount: 2,
      skillCount: 1,
      ruleCount: 1,
      outputs: [],
      moreOutputs: 0,
    },
    builtReason: null,
    deliveredTo: [],
    totalReads: 0,
    staleDeliveries: 0,
    consumers: { projects: [], lanes: [] },
    distill: [],
    ...overrides,
  };
}

test('shortVersion trims a hash to something readable and never invents one', async () => {
  const { shortVersion, NO_VALUE } = await importCore();
  assert.equal(shortVersion('0123456789abcdef0123'), '0123456789ab');
  assert.equal(shortVersion(''), NO_VALUE);
  assert.equal(shortVersion(null), NO_VALUE);
});

test('formatBuiltAt reads an ISO stamp as a plain timestamp', async () => {
  const { formatBuiltAt, NO_VALUE } = await importCore();
  assert.equal(formatBuiltAt('2026-08-20T10:00:00.000Z'), '2026-08-20 10:00:00');
  assert.equal(formatBuiltAt(null), NO_VALUE);
});

test('budget tone warns approaching the ceiling only: a written manifest can never be over it', async () => {
  const { budgetTone, BUDGET_WARN_PCT } = await importCore();
  assert.equal(BUDGET_WARN_PCT, 90);
  assert.equal(budgetTone(0), 'ok');
  assert.equal(budgetTone(89.9), 'ok');
  assert.equal(budgetTone(90), 'warn');
  assert.equal(budgetTone(100), 'warn', 'no crit tier: the builder refuses a build over budget');
  assert.equal(budgetTone(null), 'ok');
});

test('pack ordering puts invalid specs first, then anything stale, then names', async () => {
  const { sortPackRows } = await importCore();
  const rows = [
    pack({ name: 'zulu' }),
    pack({ name: 'stale-delivery', staleDeliveries: 1 }),
    pack({ name: 'alpha' }),
    pack({ name: 'broken', specValid: false }),
    pack({ name: 'stale-distill', distill: [{ output: 'a.md', stale: true, reason: 'sources changed' }] }),
  ];
  assert.deepEqual(sortPackRows(rows).map((row) => row.name), [
    'broken', 'stale-delivery', 'stale-distill', 'alpha', 'zulu',
  ]);
});

test('the attention signature names every actionable fact and nothing standing', async () => {
  const { millAttentionSignature } = await importCore();
  const quiet = { packs: [pack()], configWarnings: [] };
  assert.equal(millAttentionSignature(quiet), '', 'a healthy mill raises no dot');

  const loud = {
    packs: [
      pack({ name: 'broken', specValid: false }),
      pack({ name: 'drifting', staleDeliveries: 2, distill: [{ output: 'sources/a.md', stale: true, reason: 'sources changed' }] }),
    ],
    configWarnings: ['project "x" names pack "ghost", which has no spec'],
  };
  const signature = millAttentionSignature(loud);
  assert.ok(signature.includes('invalid:broken'));
  assert.ok(signature.includes('stale:drifting:2'));
  assert.ok(signature.includes('distill:sources/a.md'));
  assert.ok(signature.includes('config:project "x" names pack "ghost", which has no spec'));
});

test('the signature moves when the count behind it moves, so a worse fact re-lights the dot', async () => {
  const { millAttentionSignature } = await importCore();
  const one = millAttentionSignature({ packs: [pack({ staleDeliveries: 1 })] });
  const two = millAttentionSignature({ packs: [pack({ staleDeliveries: 2 })] });
  assert.notEqual(one, two);
});

test('a drift check that could not run says so instead of claiming current or stale', async () => {
  const { distillText, distillTone } = await importCore();
  assert.equal(distillText({ output: 'a.md', stale: false, reason: null }), 'current');
  assert.equal(distillText({ output: 'a.md', stale: true, reason: 'sources changed' }), 'stale: sources changed');
  assert.equal(distillText({ output: 'a.md', stale: null, reason: 'EACCES' }), 'check failed: EACCES');
  assert.equal(distillTone({ stale: false }), 'ok');
  assert.equal(distillTone({ stale: null }), 'warn');
});

test('a pack nothing names is said out loud rather than left blank', async () => {
  const { consumerLine } = await importCore();
  assert.equal(consumerLine(pack()), 'Delivered to nothing: no project or lane names this pack.');
  assert.equal(
    consumerLine(pack({ consumers: { projects: ['glissa', 'other'], lanes: [{ kind: 'prReview', label: 'prReview.packs' }] } })),
    'Delivered to projects: glissa, other, the PR review lane.',
  );
});

test('the built line falls back to the skip reason when a pack has no build', async () => {
  const { builtLine } = await importCore();
  assert.equal(builtLine(pack()), 'Version abcdef012345, built 2026-08-20 10:00:00');
  assert.equal(builtLine(pack({ built: null, builtReason: 'not built (no dir)' })), 'Not built: not built (no dir)');
  assert.equal(builtLine(pack({ built: null, builtReason: null })), 'Not built.');
});

test('the budget line states the ratio, and says so when there is no budget to state', async () => {
  const { budgetLine } = await importCore();
  assert.equal(budgetLine(pack()), '4k of 8k tokens, 50% of budget');
  const noBudget = pack();
  noBudget.built.budgetPct = null;
  assert.equal(budgetLine(noBudget), '4k tokens, no budget declared');
  assert.equal(budgetLine({ built: null }), '');
});

test('auto rebuild reports watcher coverage, because on with zero watchers is a different state', async () => {
  const { autoRebuildLine } = await importCore();
  assert.equal(autoRebuildLine({ autoRebuild: true, watcherCount: 4 }), 'Auto rebuild is on, watching 4 source roots.');
  assert.equal(autoRebuildLine({ autoRebuild: true, watcherCount: null }), 'Auto rebuild is on.');
  assert.ok(autoRebuildLine({ autoRebuild: false }).startsWith('Auto rebuild is off.'));
});

test('shouldApplyMillReport drops a superseded reply and keeps an unsolicited one', async () => {
  const { shouldApplyMillReport } = await importCore();
  assert.equal(shouldApplyMillReport({ requestId: 'mill-2' }, 'mill-2'), true);
  assert.equal(shouldApplyMillReport({ requestId: 'mill-1' }, 'mill-2'), false);
  assert.equal(shouldApplyMillReport({ requestId: null }, 'mill-2'), true, 'a connect replay carries no id');
  assert.equal(shouldApplyMillReport({}, 'mill-2'), true);
  assert.equal(shouldApplyMillReport(null, 'mill-2'), false);
});

test('an error report is recognized and rendered as its reason', async () => {
  const { isMillUnavailable, millErrorLine } = await importCore();
  assert.equal(isMillUnavailable({ error: null }), false);
  assert.equal(isMillUnavailable({ error: 'boom' }), true);
  assert.equal(millErrorLine({ error: 'boom' }), 'The context mill report is unavailable: boom');
  assert.equal(millErrorLine({ error: null }), '');
});

test('an unmeasured token estimate is said out loud, never rendered as an empty pack', async () => {
  const { budgetLine, indexLine } = await importCore();
  const unmeasured = pack();
  unmeasured.built.tokenEstimate = null;
  unmeasured.built.budgetPct = null;
  unmeasured.built.indexTokenEstimate = null;
  assert.equal(budgetLine(unmeasured), 'The manifest records no token estimate.');
  assert.equal(indexLine(unmeasured.built), '', 'an unmeasured index line is dropped rather than printed as zero');
  assert.equal(indexLine(pack().built), 'index 300 of 1.2k tokens, the always-loaded tier');
});

// ── Consumer gating and the assignment control ──

test('an unbuilt pack nothing consumes reads as a plain fact, not as a warning', async () => {
  const { builtLine, builtTone, deliveryEmptyText } = await importCore();
  const unconsumed = pack({ built: null, builtReason: 'not built', hasConsumers: false });
  assert.equal(builtLine(unconsumed), 'Not built: no consumers, so the mill neither builds nor watches it.');
  assert.equal(builtTone(unconsumed), 'ok', 'a deliberate skip must not render as a problem');
  assert.equal(deliveryEmptyText(unconsumed), 'Nothing is running it: no project or lane delivers this pack.');
});

test('an unbuilt pack something DOES consume keeps its warning', async () => {
  const { builtLine, builtTone } = await importCore();
  const consumed = pack({ built: null, builtReason: 'not built', hasConsumers: true });
  assert.equal(builtLine(consumed), 'Not built: not built');
  assert.equal(builtTone(consumed), 'warn');
  assert.equal(builtTone(pack()), 'ok', 'a built pack is fine either way');
});

test('a zero-consumer pack is never an attention part', async () => {
  const { millAttentionSignature } = await importCore();
  const quiet = { packs: [pack({ built: null, builtReason: 'not built', hasConsumers: false })], configWarnings: [] };
  assert.equal(millAttentionSignature(quiet), millAttentionSignature({ packs: [], configWarnings: [] }));
});

test('deliveryTargets marks the projects this pack is delivered to, and who is at the cap', async () => {
  const { deliveryTargets } = await importCore();
  const report = {
    maxPacksPerProject: 4,
    projects: [
      { id: 'p1', name: 'glissa', packs: ['company-context'] },
      { id: 'p2', name: 'other', packs: [] },
      { id: 'p3', name: 'full', packs: ['a', 'b', 'c', 'd'] },
      { id: 'p4', name: 'full-with-it', packs: ['company-context', 'b', 'c', 'd'] },
    ],
  };
  const targets = deliveryTargets(report, pack());
  assert.deepEqual(targets.map((t) => [t.id, t.checked, t.disabled]), [
    ['p1', true, false],
    ['p2', false, false],
    ['p3', false, true],
    ['p4', true, false],
  ], 'a project at the cap can still DROP the pack it already delivers');
});

test('a project with no id is not an assignment target: nothing could address it', async () => {
  const { deliveryTargets } = await importCore();
  const targets = deliveryTargets({ maxPacksPerProject: 4, projects: [{ name: 'idless', packs: [] }] }, pack());
  assert.deepEqual(targets, []);
});

test('a toggle sends a delta, not a list, so two dashboards cannot clobber each other', async () => {
  const { packDeltaFor } = await importCore();
  assert.deepEqual(packDeltaFor({ id: 'p1', checked: false }, 'company-context'),
    { projectId: 'p1', pack: 'company-context', deliver: true });
  assert.deepEqual(packDeltaFor({ id: 'p1', checked: true }, 'company-context'),
    { projectId: 'p1', pack: 'company-context', deliver: false });
});

test('an unknown lane kind renders as its config label rather than vanishing', async () => {
  const { consumerLine } = await importCore();
  const line = consumerLine(pack({ consumers: { projects: [], lanes: [{ kind: 'future', label: 'future.packs' }] } }));
  assert.equal(line, 'Delivered to future.packs.');
});

test('zero watchers reads as the nothing-consumed steady state, not as a health warning', async () => {
  const { autoRebuildLine } = await importCore();
  const quiet = { autoRebuild: true, watcherCount: 0, totals: { packCount: 3, unconsumed: 3 } };
  assert.equal(autoRebuildLine(quiet), 'Auto rebuild is on. No pack is delivered anywhere, so there is nothing to watch.');

  // Something IS delivered and still nothing is watched: that is the case this line exists to catch.
  const stuck = { autoRebuild: true, watcherCount: 0, totals: { packCount: 3, unconsumed: 1 } };
  assert.match(autoRebuildLine(stuck), /waiting on the fallback sweep/);
});

test('the assignment hint quotes the cap the server shipped, and says nothing without one', async () => {
  const { deliverToCapHint } = await importCore();
  assert.ok(deliverToCapHint({ maxPacksPerProject: 4 }).startsWith('Up to 4 packs per project.'));
  assert.equal(deliverToCapHint({}), '');
});

// ---- Per-project variants: separate packs, read as one pack's story ----

test('a pack keeps its variants beside it, and the family is ranked by its worst row', async () => {
  const { sortPackRows } = await importCore();
  const rows = [
    pack({ name: 'zulu' }),
    pack({ name: 'memory-other-87654321', group: 'memory' }),
    pack({ name: 'alpha' }),
    pack({ name: 'memory' }),
    pack({ name: 'memory-glissa-12345678', group: 'memory', staleDeliveries: 1 }),
  ];
  assert.deepEqual(sortPackRows(rows).map((row) => row.name), [
    'memory', 'memory-glissa-12345678', 'memory-other-87654321', 'alpha', 'zulu',
  ]);
});

test('a variant row says what it is; an ordinary pack says nothing extra', async () => {
  const { variantNote } = await importCore();
  const note = variantNote(pack({ name: 'memory-glissa-12345678', group: 'memory', consumers: { projects: ['glissa'], lanes: [] } }));
  assert.match(note, /variant of "memory"/);
  assert.match(note, /glissa/);
  assert.equal(variantNote(pack()), '');
});

test('a variant is never assignable: the project assigns the group and the mill derives the rest', async () => {
  const { deliveryTargets } = await importCore();
  const report = { maxPacksPerProject: 4, projects: [{ id: 'p1', name: 'glissa', packs: ['memory'] }] };
  assert.deepEqual(deliveryTargets(report, pack({ name: 'memory-glissa-12345678', group: 'memory' })), []);
  assert.equal(deliveryTargets(report, pack({ name: 'memory' })).length, 1);
});
