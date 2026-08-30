'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConfigStore, DEFAULT_CONFIG } = require('../server/config-store');
const { Config, HIDDEN_CONFIG_KEYS } = require('../shared/contracts');

test('DEFAULT_CONFIG satisfies the persisted Config contract', () => {
  assert.equal(Config.safeParse(DEFAULT_CONFIG).success, true);
});

// The config contract gates the LOAD, and the load exits on error, so NOTHING under `hooks` may cost
// the boot: not a record missing a field, not a stray string in the list, not a paste of Claude Code's
// own event-keyed object. session/core/user-hooks-core.js judges the value at read time instead.
test('any hooks value parses, so one hand edit cannot cost the boot', () => {
  const cases = [[{ id: 'x' }], [{ id: 'x', enabled: 'yes', timeout: 0, type: 'prompt' }], [{}], [null], ['x'], { Stop: [] }, 'nope'];
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
