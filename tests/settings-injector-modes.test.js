'use strict';

// The per-session settings file carries a live hook bearer token and lives in the SHARED system temp
// dir on POSIX hosts. Written with default modes, any other user on a multi-user box could read every
// live token and forge hook callbacks; a pre-created directory (or a symlink standing in for one)
// turned the spawn-time write into an arbitrary-file write as the server account.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeSessionSettings, DIR_MODE, FILE_MODE } = require('../detection/settings-injector');

const POSIX = process.platform !== 'win32';

function tempBase() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-hook-modes-')), 'glissa-hooks');
}

test('the settings file and its directories are created 0600/0700', { skip: POSIX ? false : 'modes are advisory on Windows' }, () => {
  const baseDir = tempBase();
  const written = writeSessionSettings({ glissaId: 'sess-1', port: 3000, baseDir });
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
  const written = writeSessionSettings({ glissaId: 'sess-2', port: 3000, baseDir });
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
  const written = writeSessionSettings({ glissaId: 'sess-3', port: 3000, baseDir });
  try {
    assert.equal(fs.statSync(written.settingsPath).mode & 0o777, FILE_MODE);
  } finally {
    written.cleanup();
  }
});

// The symlink case is the one that mattered most: /tmp/glissa-hooks pointed at somewhere else turns
// every session spawn into a write the attacker chose the destination of.
test('a base path that is a symlink rather than a real directory is refused', { skip: POSIX ? false : 'symlink creation needs privileges on Windows' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-hook-symlink-'));
  const target = path.join(root, 'elsewhere');
  fs.mkdirSync(target);
  const baseDir = path.join(root, 'glissa-hooks');
  fs.symlinkSync(target, baseDir, 'dir');
  assert.throws(
    () => writeSessionSettings({ glissaId: 'sess-4', port: 3000, baseDir }),
    /not a directory/
  );
});

test('the written settings still contain the hooks the session needs', () => {
  const baseDir = tempBase();
  const written = writeSessionSettings({ glissaId: 'sess-5', port: 3000, baseDir });
  try {
    const parsed = JSON.parse(fs.readFileSync(written.settingsPath, 'utf8'));
    assert.equal(typeof parsed.hooks.Stop[0].hooks[0].url, 'string');
    assert.match(parsed.hooks.Stop[0].hooks[0].url, new RegExp(`t=${written.token}$`));
  } finally {
    written.cleanup();
  }
});
