import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore, DEFAULT_CONFIG } from '../server/config-store.ts';
import {
  BRANCH_GC_CONTROL_BOOLEAN_KEYS, BRANCH_GC_CONTROL_NUMERIC_KEYS, BranchGcFileSettings,
  BrowserConfig, Config, CONFIG_BLOCK_KEYS, configIssueMessage, ConfigUpdate, HIDDEN_CONFIG_KEYS,
} from '../shared/contracts/index.ts';

test('DEFAULT_CONFIG satisfies the persisted Config contract', () => {
  assert.equal(Config.safeParse(DEFAULT_CONFIG).success, true);
  assert.equal(DEFAULT_CONFIG.integrationBranch, null);
  assert.equal(DEFAULT_CONFIG.updateChannel, 'release');
  assert.equal(Config.shape.integrationBranch.safeParse(null).success, true);
  assert.equal(DEFAULT_CONFIG.trace.enabled, true);
});

test('trace.enabled is a boolean file-only setting with a default-on projection', () => {
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, trace: { enabled: false } }).success, true);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, trace: { enabled: 'false' } }).success, false);
  assert.equal('trace' in ConfigUpdate.shape, false);
  assert.equal('trace' in BrowserConfig.shape, false);
});

test('updateChannel accepts release and main across config boundaries', () => {
  for (const updateChannel of ['release', 'main']) {
    assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, updateChannel }).success, true);
    assert.equal(BrowserConfig.safeParse({ updateChannel }).success, true);
    assert.equal(ConfigUpdate.safeParse({ updateChannel }).success, true);
  }
  assert.equal(ConfigUpdate.safeParse({ updateChannel: 'nightly' }).success, false);
});

test('mill measurement retention crosses file, browser, and update boundaries', () => {
  const millMetrics = { retainDays: 90 };
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, millMetrics }).success, true);
  assert.equal(BrowserConfig.safeParse({ millMetrics }).success, true);
  assert.equal(ConfigUpdate.safeParse({ millMetrics }).success, true);
  assert.equal(CONFIG_BLOCK_KEYS.includes('millMetrics'), true);
});

test('the persisted mill measurement block keeps its retention setting', () => {
  const config = { ...DEFAULT_CONFIG, millMetrics: { retainDays: 90 } };
  assert.deepEqual(Config.parse(config).millMetrics, { retainDays: 90 });
});

test('branchGc prefixes parse as string arrays and reject non-arrays', () => {
  assert.equal(BranchGcFileSettings.safeParse({ prefixes: ['glissa/session/', 'worktree-agent-'] }).success, true);
  assert.equal(BranchGcFileSettings.safeParse({ prefixes: 'glissa/session/' }).success, false);
});

test('branchGc worktrees is file-only and boolean', () => {
  assert.equal(BranchGcFileSettings.safeParse({ worktrees: false }).success, true);
  assert.equal(BranchGcFileSettings.safeParse({ worktrees: 'false' }).success, false);
  assert.deepEqual(ConfigUpdate.parse({ branchGc: { worktrees: false } }).branchGc, {});
});

test('a branchGc prefix that would select every origin branch fails closed', () => {
  const parsed = BranchGcFileSettings.safeParse({ prefixes: ['glissa/session/', ''] });
  assert.equal(parsed.success, false);
  assert.equal(parsed.success === false && configIssueMessage(parsed.error), 'branchGc.prefixes entries must be non-empty strings');
});

test('a hand-edited branchGc field type never costs the boot', () => {
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, branchGc: { staleDays: '21' } }).success, true);
});

test('the branchGc control update keeps its literal key types', () => {
  const staleDays: number | undefined = ConfigUpdate.parse({ branchGc: { staleDays: 21 } }).branchGc?.staleDays;
  assert.equal(staleDays, 21);
});

test('the control update keeps exactly the exported settable branchGc keys', () => {
  const parsed = ConfigUpdate.parse({
    branchGc: { enabled: true, staleDays: 21, intervalMs: 3600000, prefixes: ['evil/'], dryRun: true },
  });
  assert.deepEqual(
    Object.keys(parsed.branchGc ?? {}).sort(),
    [...BRANCH_GC_CONTROL_BOOLEAN_KEYS, ...BRANCH_GC_CONTROL_NUMERIC_KEYS].sort(),
  );
});

test('any hooks value parses, so one hand edit cannot cost the boot', () => {
  const cases: unknown[] = [
    [{ id: 'x' }],
    [{ id: 'x', enabled: 'yes', timeout: 0, type: 'prompt' }],
    [{}],
    [null],
    ['x'],
    { Stop: [] },
    'nope',
  ];
  for (const hooks of cases) {
    assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, hooks }).success, true, JSON.stringify(hooks));
  }
});

test('hidden persisted config keys never enter the browser settings projection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-contract-config-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ ...DEFAULT_CONFIG, trace: {} }), 'utf8');
  const previousConfig = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  try {
    const settings = createConfigStore().getSettings();
    assert.deepEqual(HIDDEN_CONFIG_KEYS.filter((key) => Object.hasOwn(settings, key)), []);
    assert.deepEqual(settings.trace, { enabled: true });
  } finally {
    if (previousConfig == null) delete process.env.GLISSA_CONFIG;
    if (previousConfig != null) process.env.GLISSA_CONFIG = previousConfig;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
