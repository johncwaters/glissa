import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { decideConfigPath, glimmervoidHomeDir } from '../server/core/config-path-core.ts';

const HOME = path.join('/home', 'operator', '.glimmervoid');
const decide = (env: { GLIMMERVOID_CONFIG?: string }, present: string[]) => decideConfigPath({ env, homeDir: HOME }, (candidate) => present.includes(candidate));

test('GLIMMERVOID_CONFIG wins when it names a file that exists', () => {
  const named = path.resolve('/tmp/custom.json');
  const decided = decide({ GLIMMERVOID_CONFIG: named }, [named]);
  assert.equal(decided.path, named);
  assert.equal(decided.source, 'env');
});

test('a GLIMMERVOID_CONFIG that is not there never falls through to another config', () => {
  const named = path.resolve('/tmp/missing.json');
  const decided = decide({ GLIMMERVOID_CONFIG: named }, [path.join(HOME, 'config.json')]);
  assert.equal(decided.path, null);
  assert.equal(decided.source, 'env');
  assert.equal(decided.envPath, named);
});

test('the home config is selected when present and absent otherwise', () => {
  const home = path.join(HOME, 'config.json');
  assert.equal(decide({}, [home]).path, home);

  const none = decide({}, []);
  assert.equal(none.path, null);
  assert.equal(none.source, 'none');
  assert.equal(none.homePath, home);
});

test('the home directory has one spelling', () => {
  assert.equal(path.basename(glimmervoidHomeDir('/home/operator', {})), '.glimmervoid');
});

test('GLIMMERVOID_HOME overrides the home directory', () => {
  const glimmervoidHome = path.join('/tmp', 'glimmervoid-home');
  assert.equal(glimmervoidHomeDir('/home/operator', { GLIMMERVOID_HOME: glimmervoidHome }), path.resolve(glimmervoidHome));
});
