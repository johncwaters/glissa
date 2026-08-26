'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SETTINGS_RANGES } = require('../shared/settings-ranges');

async function load() {
  const [{ SETTINGS_MAP }, core] = await Promise.all([
    import('../public/settings-map.mjs'),
    import('../public/settings-view-core.mjs'),
  ]);
  return { SETTINGS_MAP, ...core };
}

test('an untouched section writes nothing', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = { prReview: { enabled: false, intervalMinutes: 15 } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {});
});
test('one dirty lane sends only its top-level block and preserves stored sibling keys', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = {
    prReview: { enabled: false, intervalMinutes: 15, mergeMethod: 'squash', futureKey: 7 },
    visions: { enabled: false },
  };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  edited['prReview.enabled'] = true;
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {
    prReview: { enabled: true, intervalMinutes: 15, mergeMethod: 'squash', futureKey: 7 },
  });
});

test('the legacy memory retention alias moves with retainDays', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = { memory: { retainDays: 90, memoryRetainDays: 120 } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  assert.equal(original['memory.retainDays'], 120);
  edited['memory.retainDays'] = 180;
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {
    memory: { retainDays: 180, memoryRetainDays: 180 },
  });
});

test('an unrendered stored project id survives a projects-control save', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = {
    projectChoices: [{ id: 'shown', name: 'Shown' }],
    visions: { enabled: true, projects: ['shown', 'missing'] },
  };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  edited['visions.projects'] = [];
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {
    visions: { enabled: true, projects: ['missing'] },
  });
});

test('a settings refresh preserves dirty sections and refreshes clean sections', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings, rehydratePreservingDirtySections } = await load();
  const currentPayload = {
    prReview: { enabled: false, intervalMinutes: 15 },
    visions: { enabled: false },
  };
  const currentOriginal = hydrateFromSettings(SETTINGS_MAP, currentPayload);
  const currentEdited = hydrateFromSettings(SETTINGS_MAP, currentPayload);
  currentEdited['prReview.enabled'] = true;
  const freshPayload = {
    prReview: { enabled: false, intervalMinutes: 30 },
    visions: { enabled: true },
  };
  const { original, edited } = rehydratePreservingDirtySections(
    SETTINGS_MAP,
    freshPayload,
    currentOriginal,
    currentEdited,
  );
  assert.equal(edited['prReview.enabled'], true);
  assert.equal(edited['visions.enabled'], true);
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {
    prReview: { enabled: true, intervalMinutes: 30 },
  });
});

test('zero and negative budgets validate and serialize as no ceiling', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings, validateLocally } = await load();
  const usageSection = SETTINGS_MAP.find((section) => section.id === 'machine-usage');
  const payload = { usage: { budget: { dailyUsd: 20, monthlyUsd: 100 } } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  edited['usage.budget.dailyUsd'] = -1;
  edited['usage.budget.monthlyUsd'] = 0;
  assert.deepEqual(validateLocally([usageSection], edited, SETTINGS_RANGES), {});
  assert.deepEqual(collectDirtyBlocks([usageSection], original, edited), {
    usage: { budget: { dailyUsd: null, monthlyUsd: null } },
  });
});

test('a successful save rehydrates its section while preserving other dirty sections', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings, rehydratePreservingDirtySections } = await load();
  const currentPayload = {
    prReview: { enabled: false },
    visions: { enabled: false, autoFix: false },
  };
  const currentOriginal = hydrateFromSettings(SETTINGS_MAP, currentPayload);
  const currentEdited = hydrateFromSettings(SETTINGS_MAP, currentPayload);
  currentEdited['prReview.enabled'] = true;
  currentEdited['visions.autoFix'] = true;
  const freshPayload = {
    prReview: { enabled: true },
    visions: { enabled: false, autoFix: false },
  };
  const { original, edited } = rehydratePreservingDirtySections(
    SETTINGS_MAP,
    freshPayload,
    currentOriginal,
    currentEdited,
    { rehydrateSectionIds: ['lanes-pr-review'] },
  );
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {
    visions: { enabled: false, autoFix: true },
  });
});
