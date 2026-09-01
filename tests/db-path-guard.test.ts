import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HOME_DB_REFUSED_CODE,
  HOME_DB_REFUSED_NAME,
  decideDbOpenRefusal,
  underTestRunner,
} from '../server/core/db-path-guard.ts';
import { dbPathForConfig, openDatabase } from '../server/glissa-db.ts';
import { createMemoryStore } from '../server/memory-store.js';
import { resolveMemoryConfig } from '../server/core/memory-core.ts';

const HOME = os.homedir();

test('the node test runner is what arms the guard', () => {
  assert.equal(underTestRunner(process.env), true, 'this suite runs under node --test');
  assert.equal(underTestRunner({}), false);
  assert.equal(underTestRunner({ NODE_TEST_CONTEXT: '' }), false);
});

test('a home-directory database is refused under the runner and allowed outside it', () => {
  const target = path.join(HOME, '.glissa', 'glissa.db');
  const refusal = decideDbOpenRefusal({ dbPath: target, homeDir: HOME, tmpDir: '/nowhere', isTestRunner: true });
  assert.match(refusal || '', /refusing to open a database under the home directory/);
  assert.ok((refusal ?? '').includes(target), 'the refusal names the path it declined');
  assert.equal(
    decideDbOpenRefusal({ dbPath: target, homeDir: HOME, tmpDir: '/nowhere', isTestRunner: false }),
    null,
    'a real server run opens its own store',
  );
});

test('a temp fixture under a home-rooted TEMP still opens', () => {
  const homeTemp = path.join(HOME, 'AppData', 'Local', 'Temp');
  const target = path.join(homeTemp, 'glissa-x', 'glissa.db');
  assert.equal(
    decideDbOpenRefusal({ dbPath: target, homeDir: HOME, tmpDir: homeTemp, isTestRunner: true }),
    null,
    'a Windows runner puts every temp fixture under the home directory',
  );
});

test('a database outside the home directory is never refused', () => {
  const target = path.join(os.tmpdir(), 'glissa-guard-outside', 'glissa.db');
  assert.equal(decideDbOpenRefusal({ dbPath: target, homeDir: HOME, tmpDir: os.tmpdir(), isTestRunner: true }), null);
});

test('openDatabase throws the named refusal rather than touching the operator store', () => {
  const target = dbPathForConfig(path.join(HOME, '.glissa', 'config.json'));
  const before = fs.existsSync(target) ? fs.statSync(target).mtimeMs : null;
  assert.throws(() => openDatabase(target), (error: unknown) => {
    const failure = error as { name?: string; code?: string };
    assert.equal(failure.name, HOME_DB_REFUSED_NAME);
    assert.equal(failure.code, HOME_DB_REFUSED_CODE);
    return true;
  });
  const after = fs.existsSync(target) ? fs.statSync(target).mtimeMs : null;
  assert.equal(after, before, 'the refused open left the live database untouched');
});

test('the memory store propagates the refusal instead of reporting the lane off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-guard-store-'));
  try {
    assert.throws(() => createMemoryStore({
      dir,
      dbPath: path.join(HOME, '.glissa', 'glissa.db'),
      config: { ...resolveMemoryConfig(null), enabled: true },
      logger: { log() {}, warn() {} },
    }), { code: HOME_DB_REFUSED_CODE });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the store refuses to guess either of its two locations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-guard-args-'));
  try {
    assert.throws(() => createMemoryStore({ dbPath: path.join(dir, 'glissa.db') }), /explicit dir/);
    assert.throws(() => createMemoryStore({ dir }), /explicit dbPath/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dbPathForConfig is the single spelling of where the database lives', () => {
  assert.equal(dbPathForConfig('/tmp/x/config.json'), path.join('/tmp/x', 'glissa.db'));
  assert.throws(() => dbPathForConfig(''), /needs a config file path/);
});
