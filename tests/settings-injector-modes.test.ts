import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildHookSettings,
  writeSessionSettings,
  DIR_MODE,
  FILE_MODE,
  WAKEUP_TOOL_MATCHER,
} from '../detection/settings-injector.ts';

const POSIX = process.platform !== 'win32';

function tempBase() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-hook-modes-')), 'glimmervoid-hooks');
}

test('the settings file and its directories are created 0600/0700', { skip: POSIX ? false : 'modes are advisory on Windows' }, () => {
  const baseDir = tempBase();
  const written = writeSessionSettings({ glimmervoidId: 'sess-1', port: 3000, baseDir });
  try {
    assert.equal(fs.statSync(written.settingsPath).mode & 0o777, FILE_MODE);
    assert.equal(fs.statSync(written.dir).mode & 0o777, DIR_MODE);
    assert.equal(fs.statSync(baseDir).mode & 0o777, DIR_MODE);
  } finally {
    written.cleanup();
  }
});

test('a base directory left behind with loose modes is tightened, not trusted as found', { skip: POSIX ? false : 'modes are advisory on Windows' }, () => {
  const baseDir = tempBase();
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o777 });
  fs.chmodSync(baseDir, 0o777);
  const written = writeSessionSettings({ glimmervoidId: 'sess-2', port: 3000, baseDir });
  try {
    assert.equal(fs.statSync(baseDir).mode & 0o777, DIR_MODE);
  } finally {
    written.cleanup();
  }
});

test('a settings file left behind by an earlier run does not keep its old mode', { skip: POSIX ? false : 'modes are advisory on Windows' }, () => {
  const baseDir = tempBase();
  const dir = path.join(baseDir, 'sess-3');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'settings.json');
  fs.writeFileSync(stale, '{}', { mode: 0o666 });
  fs.chmodSync(stale, 0o666);
  const written = writeSessionSettings({ glimmervoidId: 'sess-3', port: 3000, baseDir });
  try {
    assert.equal(fs.statSync(written.settingsPath).mode & 0o777, FILE_MODE);
  } finally {
    written.cleanup();
  }
});

test('a base path that is a symlink rather than a real directory is refused', { skip: POSIX ? false : 'symlink creation needs privileges on Windows' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-hook-symlink-'));
  const target = path.join(root, 'elsewhere');
  fs.mkdirSync(target);
  const baseDir = path.join(root, 'glimmervoid-hooks');
  fs.symlinkSync(target, baseDir, 'dir');
  assert.throws(
    () => writeSessionSettings({ glimmervoidId: 'sess-4', port: 3000, baseDir }),
    /not a directory/
  );
});

test('the written settings still contain the hooks the session needs', () => {
  const baseDir = tempBase();
  const written = writeSessionSettings({ glimmervoidId: 'sess-5', port: 3000, baseDir });
  try {
    const parsed = JSON.parse(fs.readFileSync(written.settingsPath, 'utf8'));
    assert.equal(typeof parsed.hooks.Stop[0].hooks[0].url, 'string');
    assert.match(parsed.hooks.Stop[0].hooks[0].url, new RegExp(`t=${written.token}$`));
  } finally {
    written.cleanup();
  }
});

test('no Read matcher reaches PostToolUse, since nothing consumes pack reads', () => {
  const base = { port: 3000, glimmervoidId: 'metrics', token: 'tok' };
  const settings = buildHookSettings(base);
  assert.deepEqual(settings.hooks.PostToolUse.map((entry: { matcher?: string }) => entry.matcher), [
    WAKEUP_TOOL_MATCHER,
  ]);
});
