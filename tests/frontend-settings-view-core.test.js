'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SETTINGS_RANGES } = require('../shared/settings-ranges.ts');

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
    prReview: { projects: [] },
    visions: { enabled: false },
  };
  const currentOriginal = hydrateFromSettings(SETTINGS_MAP, currentPayload);
  const currentEdited = hydrateFromSettings(SETTINGS_MAP, currentPayload);
  currentEdited['prReview.projects'] = ['project-1'];
  currentEdited['visions.enabled'] = true;
  const freshPayload = {
    prReview: { projects: ['project-1'] },
    visions: { enabled: false },
  };
  const { original, edited } = rehydratePreservingDirtySections(
    SETTINGS_MAP,
    freshPayload,
    currentOriginal,
    currentEdited,
    { rehydrateSectionIds: ['lanes-pr-review'] },
  );
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {
    visions: { enabled: true },
  });
});

test('search uses exact tokens and weighted fields', async () => {
  const { scoreSettingsSearch } = await load();
  const map = [
    { id: 'feature', level: 'machine', title: 'Feature flags', settings: [
      { id: 'feature-flag', title: 'Feature flag', description: 'Controls a switch.', keywords: ['toggle', 'option'] },
    ] },
    { id: 'thermal', level: 'machine', title: 'Heat controls', settings: [
      { id: 'temperature', title: 'Temperature', description: 'Controls heat output.', keywords: ['thermal', 'warmth'] },
      { id: 'keyword-only', title: 'Cooling', description: 'Controls airflow.', keywords: ['heat', 'thermal'] },
    ] },
    { id: 'other', level: 'machine', title: 'Other', settings: [
      { id: 'title-match', title: 'Heat limit', description: 'A ceiling.', keywords: ['temperature', 'ceiling'] },
    ] },
  ];
  const results = scoreSettingsSearch(map, 'heat');
  assert.equal(results.some((entry) => entry.setting.id === 'feature-flag'), false);
  assert.equal(results.some((entry) => entry.setting.id === 'keyword-only'), true);
  assert.equal(results[0].setting.id, 'title-match');
  assert.ok(results.findIndex((entry) => entry.setting.id === 'temperature') > 0);
  assert.deepEqual(scoreSettingsSearch(map, ''), []);
});

test('settings hashes resolve aliases and canonical anchors', async () => {
  const { SETTINGS_MAP, parseSettingsHash } = await load();
  const aliases = { general: 'machine-general' };
  assert.deepEqual(parseSettingsHash('#settings/general/auto-resume', SETTINGS_MAP, aliases), {
    sectionId: 'machine-general', settingId: 'auto-resume', hash: '#settings/machine-general/auto-resume',
  });
  assert.equal(parseSettingsHash('#settings/missing', SETTINGS_MAP, aliases), null);
  assert.equal(parseSettingsHash('#settings/machine-general/missing', SETTINGS_MAP, aliases), null);
});

test('unattended actions sort last within the map', async () => {
  const { orderSections } = await load();
  const ordered = orderSections([
    { id: 'lanes-unattended', level: 'lanes' },
    { id: 'lanes-pr-review', level: 'lanes' },
    { id: 'lanes-mill', level: 'lanes' },
    { id: 'project-one', level: 'projects' },
  ]);
  assert.deepEqual(ordered.map((section) => section.id), [
    'lanes-pr-review', 'lanes-mill', 'lanes-unattended', 'project-one',
  ]);
});

test('danger toggles require an exact confirmation only when turning on', async () => {
  const { decideDangerToggle } = await load();
  assert.equal(decideDangerToggle(false, true, 'pr review', 'pr-review'), false);
  assert.equal(decideDangerToggle(false, true, 'pr-review', 'pr-review'), true);
  assert.equal(decideDangerToggle(true, false, '', 'pr-review'), false);
});

test('project sections derive pack controls and read-only records', async () => {
  const { buildProjectSections } = await load();
  const sections = buildProjectSections(
    [{ id: 'p1', name: 'Glissa', packs: ['context'], agent: 'codex', permissionMode: 'default' }],
    [{ name: 'context' }, { name: 'variant', group: 'context' }],
  );
  assert.equal(sections[0].id, 'project-p1');
  assert.deepEqual(sections[0].settings[0].options, ['context']);
  assert.equal(sections[0].settings[1].value, 'codex');
  assert.equal(sections[0].settings[3].fileOnly, true);
});

test('two card records on one Mill project use the checkout name and list both cards', async () => {
  const { buildProjectSections, enrichProjectsById } = await load();
  const groupedProjects = [{ id: 'p1', name: 'glissa', packs: ['context'] }];
  const cardRecords = [
    { id: 'p1', name: 'glissa', path: '/repos/glissa', agent: 'codex' },
    { id: 'p2', name: 'glissa (2)', path: '/repos/glissa', agent: 'claude-code' },
  ];
  const projects = enrichProjectsById(groupedProjects, cardRecords);
  const sections = buildProjectSections(projects, [{ name: 'context' }]);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 'project-p1');
  assert.equal(sections[0].title, 'glissa');
  assert.equal(sections[0].caption, 'Cards: glissa, glissa (2)');
  assert.equal(sections[0].settings[1].value, 'codex');
});

test('a stored secret hydrates as a mask and an untouched section sends nothing', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings, STORED_SECRET_MASK } = await load();
  const payload = { telegram: { chatId: '123', botTokenConfigured: true }, posthog: { enabled: true, apiKeyConfigured: false } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);

  assert.equal(original['telegram.botToken'], STORED_SECRET_MASK);
  assert.equal(original['posthog.apiKey'], '', 'nothing stored means an empty field');
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {});
});

test('a sibling edit never carries the mask or the presence flag to the server', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = { telegram: { chatId: '123', botTokenConfigured: true } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const edited = hydrateFromSettings(SETTINGS_MAP, payload);
  edited['telegram.chatId'] = '456';

  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), { telegram: { chatId: '456' } });
});

test('a typed secret is sent and an emptied one is sent as a clear', async () => {
  const { SETTINGS_MAP, collectDirtyBlocks, hydrateFromSettings } = await load();
  const payload = { telegram: { chatId: '123', botTokenConfigured: true } };
  const original = hydrateFromSettings(SETTINGS_MAP, payload);
  const typed = hydrateFromSettings(SETTINGS_MAP, payload);
  typed['telegram.botToken'] = 'fresh-tok';
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, typed), { telegram: { chatId: '123', botToken: 'fresh-tok' } });

  const emptied = hydrateFromSettings(SETTINGS_MAP, payload);
  emptied['telegram.botToken'] = '';
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, emptied), { telegram: { chatId: '123', botToken: '' } });
});
