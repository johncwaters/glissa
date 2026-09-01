import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { decideConfigPath, glissaHomeDir } from '../server/core/config-path-core.ts';

const HOME = path.join('/home', 'operator', '.glissa');
const PACKAGE = path.join('/opt', 'glissa');
const decide = (env: { GLISSA_CONFIG?: string }, present: string[]) => decideConfigPath({ env, homeDir: HOME, packageRoot: PACKAGE }, (candidate) => present.includes(candidate));

test('GLISSA_CONFIG wins when it names a file that exists', () => {
  const named = path.resolve('/tmp/custom.json');
  const decided = decide({ GLISSA_CONFIG: named }, [named, path.join(PACKAGE, 'config.json')]);
  assert.equal(decided.path, named);
  assert.equal(decided.source, 'env');
});

test('a GLISSA_CONFIG that is not there never falls through to another config', () => {
  const named = path.resolve('/tmp/missing.json');
  const decided = decide({ GLISSA_CONFIG: named }, [path.join(PACKAGE, 'config.json'), path.join(HOME, 'config.json')]);
  assert.equal(decided.path, null);
  assert.equal(decided.source, 'env');
  assert.equal(decided.envPath, named);
});

test('a package-local config beats the home one, and the home one beats nothing', () => {
  const local = path.join(PACKAGE, 'config.json');
  const home = path.join(HOME, 'config.json');
  assert.equal(decide({}, [local, home]).path, local);
  assert.equal(decide({}, [home]).path, home);

  const none = decide({}, []);
  assert.equal(none.path, null);
  assert.equal(none.source, 'none');
  assert.equal(none.homePath, home);
});

test('the home directory has one spelling', () => {
  assert.equal(path.basename(glissaHomeDir('/home/operator')), '.glissa');
});
