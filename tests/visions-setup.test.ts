
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { createVisionsSetup } from '../server/visions-setup.ts';
import type { ExtensionReport, WireReport } from '../server/visions-setup.ts';
import { IMPLIED_INGEST, decideImpliedDefaults } from '../server/core/visions-defaults-core.ts';

type TestConfig = {
  visions: { enabled: boolean; dispatch?: { enabled: boolean } };
  ingest?: unknown;
};

const NO_EXTENSIONS: ExtensionReport = { targets: [], reason: 'not-run', results: [] };
const WIRED: WireReport = { ok: true, reason: 'ok', extensions: NO_EXTENSIONS, files: [] };
const UNWIRED = { extensions: NO_EXTENSIONS, files: [] };
const SILENT = { log() {}, warn() {} };

function harness(initialConfig: TestConfig) {
  const config = initialConfig;
  const calls: string[] = [];
  const setup = createVisionsSetup({
    getConfig: () => config,
    configStore: {
      save(mutator) {
        mutator(config);
        return config;
      },
    },
    logger: SILENT,
    wire: async () => {
      calls.push('wire');
      return WIRED;
    },
    unwire: async () => {
      calls.push('unwire');
      return UNWIRED;
    },
  });
  return { calls, config, setup };
}

test('a boot with visions off wires nothing and unwires nothing', async () => {
  const { calls, setup } = harness({ visions: { enabled: false } });
  await setup.maybeApply();
  assert.deepEqual(calls, []);
});

test('a boot with visions on wires once, and a later save does not repeat it', async () => {
  const { calls, setup } = harness({ visions: { enabled: true } });
  await setup.maybeApply();
  await setup.maybeApply();
  assert.deepEqual(calls, ['wire']);
});

test('turning visions off unwires, turning it back on wires again', async () => {
  const { calls, config, setup } = harness({ visions: { enabled: true } });
  await setup.maybeApply();
  config.visions.enabled = false;
  await setup.maybeApply();
  config.visions.enabled = true;
  await setup.maybeApply();
  assert.deepEqual(calls, ['wire', 'unwire', 'wire']);
});

test('enabling writes the implied ingest and dispatch blocks', async () => {
  const { config, setup } = harness({ visions: { enabled: true } });
  await setup.maybeApply();
  assert.deepEqual(config.ingest, IMPLIED_INGEST);
  assert.deepEqual(config.visions.dispatch, { enabled: true });
});

test('a config under the operator home is refused while the test runner is what is running', async () => {
  const config: TestConfig = { visions: { enabled: true } };
  let saves = 0;
  const setup = createVisionsSetup({
    getConfig: () => config,
    configStore: {
      configPath: path.join(os.homedir(), '.glissa', 'config.json'),
      save() {
        saves += 1;
        return config;
      },
    },
    logger: SILENT,
    env: { NODE_TEST_CONTEXT: 'child' },
    wire: async () => WIRED,
    unwire: async () => UNWIRED,
  });

  await setup.maybeApply();
  assert.equal(saves, 0);
  assert.equal(config.ingest, undefined);
});

test('the LIVE config object is the one mutated, and the lanes are told once', async () => {
  const config: TestConfig = { visions: { enabled: true } };
  const disk: TestConfig = { visions: { enabled: true } };
  const pokes: unknown[] = [];
  const setup = createVisionsSetup({
    getConfig: () => config,
    configStore: {
      save(mutator) {
        mutator(disk);
        return disk;
      },
    },
    logger: SILENT,
    onConfigChanged: () => { pokes.push(JSON.parse(JSON.stringify(config.ingest))); },
    wire: async () => WIRED,
    unwire: async () => UNWIRED,
  });

  await setup.maybeApply();
  assert.deepEqual(config.ingest, IMPLIED_INGEST);
  assert.deepEqual(disk.ingest, IMPLIED_INGEST);
  assert.deepEqual(pokes, [IMPLIED_INGEST]);
});

test('what the operator already chose is never rewritten', () => {
  const chosen = {
    visions: { enabled: true, dispatch: { enabled: false } },
    ingest: { enabled: false },
  };
  assert.deepEqual(decideImpliedDefaults(chosen).changes, []);
  assert.deepEqual(decideImpliedDefaults({ visions: { enabled: false } }).changes, []);

  const sourcesOff = {
    visions: { enabled: true, dispatch: { enabled: true } },
    ingest: { enabled: true, sources: { fs: { enabled: false }, git: { enabled: false }, editor: { enabled: false } } },
  };
  assert.deepEqual(decideImpliedDefaults(sourcesOff).changes, []);
});

test('a source that did not exist when the block was written is still implied', () => {
  const beforeTheEditorSource = {
    visions: { enabled: true, dispatch: { enabled: true } },
    ingest: { enabled: true, sources: { fs: { enabled: true }, git: { enabled: true } } },
  };
  assert.deepEqual(decideImpliedDefaults(beforeTheEditorSource).changes.map((change) => change.path), [
    ['ingest', 'sources', 'editor'],
  ]);

  const laneOffStaysOff = {
    visions: { enabled: true, dispatch: { enabled: true } },
    ingest: { enabled: false, sources: {} },
  };
  assert.deepEqual(decideImpliedDefaults(laneOffStaysOff).changes, []);
});

test('the implied sources are movement only, never captured prose', () => {
  assert.deepEqual(Object.keys(IMPLIED_INGEST.sources), ['fs', 'git', 'editor']);
});
