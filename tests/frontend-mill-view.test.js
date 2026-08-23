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
    consumers: { projects: [], prReview: false, posthog: false },
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
    consumerLine(pack({ consumers: { projects: ['glissa', 'other'], prReview: true, posthog: false } })),
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
