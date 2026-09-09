import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { glissaHomeDir } from '../server/config-store.ts';
import { defaultBuiltRoot } from '../server/pack-builder.ts';
import { WORK_DIR } from '../server/posthog-wiring.ts';
import { defaultRecordingsDir } from '../session/session-recorder.ts';

test('the test preload isolates all Glissa paths from the operator home', () => {
  const isolatedHome = process.env.GLISSA_HOME;
  assert.ok(isolatedHome);
  assert.equal(isolatedHome, process.env.GLISSA_TEST_HOME);

  const resolvedIsolatedHome = path.resolve(isolatedHome);
  assert.equal(glissaHomeDir(), resolvedIsolatedHome);
  assert.equal(defaultBuiltRoot(), path.join(resolvedIsolatedHome, 'packs', 'built'));
  assert.equal(WORK_DIR, path.join(resolvedIsolatedHome, 'posthog-work'));
  assert.equal(defaultRecordingsDir(), path.join(resolvedIsolatedHome, 'recordings'));
  assert.notEqual(glissaHomeDir(), path.join(os.homedir(), '.glissa'));
  assert.ok(process.execArgv.includes('--import'));
});
