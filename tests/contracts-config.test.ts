import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore, DEFAULT_CONFIG } from '../server/config-store.ts';
import {
  BrowserConfig, Config, CONFIG_BLOCK_KEYS, ConfigUpdate, HIDDEN_CONFIG_KEYS,
} from '../shared/contracts/index.ts';

test('DEFAULT_CONFIG satisfies the persisted Config contract', () => {
  assert.equal(Config.safeParse(DEFAULT_CONFIG).success, true);
  assert.equal(DEFAULT_CONFIG.integrationBranch, null);
  assert.equal(Config.shape.integrationBranch.safeParse(null).success, true);
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

// The config contract gates the LOAD, and the load exits on error, so NOTHING under `hooks` may cost
// the boot: not a record missing a field, not a stray string in the list, not a paste of Claude Code's
// own event-keyed object. session/core/user-hooks-core.ts judges the value at read time instead.
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
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG), 'utf8');
  const previousConfig = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  try {
    const settings = createConfigStore().getSettings();
    assert.deepEqual(HIDDEN_CONFIG_KEYS.filter((key) => Object.hasOwn(settings, key)), []);
  } finally {
    if (previousConfig == null) delete process.env.GLISSA_CONFIG;
    if (previousConfig != null) process.env.GLISSA_CONFIG = previousConfig;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
