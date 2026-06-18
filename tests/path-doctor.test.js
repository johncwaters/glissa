'use strict';

// Unit tests for the pure PATH helpers behind `glissa doctor` and the post-install
// PATH notice. No I/O: every function takes its environment as arguments, so the
// behavior is deterministic and platform-independent under `node --test`.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  onPath,
  npmGlobalBinDir,
  pnpmGlobalBinDir,
  formatPathNotice,
} = require('../bin/path-doctor');

test('onPath: win32 is case-insensitive and trailing-separator insensitive', () => {
  const pathEnv = 'C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm';
  assert.ok(onPath('c:\\users\\me\\appdata\\roaming\\npm', { pathEnv, platform: 'win32' }));
  assert.ok(onPath('C:\\Users\\me\\AppData\\Roaming\\npm\\', { pathEnv, platform: 'win32' }));
});

test('onPath: win32 returns false when the dir is absent', () => {
  const pathEnv = 'C:\\Windows;C:\\Program Files\\nodejs';
  assert.equal(onPath('C:\\Users\\me\\AppData\\Roaming\\npm', { pathEnv, platform: 'win32' }), false);
});

test('onPath: empty or missing inputs are false, never throw', () => {
  assert.equal(onPath('', { pathEnv: 'C:\\x', platform: 'win32' }), false);
  assert.equal(onPath('C:\\x', { pathEnv: '', platform: 'win32' }), false);
  assert.equal(onPath('C:\\x', {}), false);
});

test('onPath: posix splits on colon and is case-sensitive', () => {
  const pathEnv = '/usr/bin:/home/u/.local/share/pnpm';
  assert.ok(onPath('/home/u/.local/share/pnpm', { pathEnv, platform: 'linux' }));
  assert.equal(onPath('/home/u/.local/share/PNPM', { pathEnv, platform: 'linux' }), false);
});

test('npmGlobalBinDir: win32 prefers npm_config_prefix (the prefix IS the bin dir)', () => {
  const dir = npmGlobalBinDir({ env: { npm_config_prefix: 'C:\\npm-prefix' }, platform: 'win32', homedir: 'C:\\Users\\me' });
  assert.equal(dir, 'C:\\npm-prefix');
});

test('npmGlobalBinDir: win32 falls back to AppData\\Roaming\\npm', () => {
  const dir = npmGlobalBinDir({ env: {}, platform: 'win32', homedir: 'C:\\Users\\me' });
  assert.equal(dir, path.join('C:\\Users\\me', 'AppData', 'Roaming', 'npm'));
});

test('npmGlobalBinDir: posix uses <prefix>/bin', () => {
  const dir = npmGlobalBinDir({ env: { npm_config_prefix: '/usr/local' }, platform: 'linux', homedir: '/home/u' });
  assert.equal(dir, path.join('/usr/local', 'bin'));
});

test('pnpmGlobalBinDir: PNPM_HOME wins', () => {
  assert.equal(
    pnpmGlobalBinDir({ env: { PNPM_HOME: 'C:\\pnpm' }, platform: 'win32', homedir: 'C:\\Users\\me' }),
    'C:\\pnpm',
  );
});

test('pnpmGlobalBinDir: platform defaults', () => {
  assert.equal(
    pnpmGlobalBinDir({ env: {}, platform: 'win32', homedir: 'C:\\Users\\me' }),
    path.join('C:\\Users\\me', 'AppData', 'Local', 'pnpm'),
  );
  assert.equal(
    pnpmGlobalBinDir({ env: {}, platform: 'linux', homedir: '/home/u' }),
    path.join('/home/u', '.local', 'share', 'pnpm'),
  );
});

test('formatPathNotice: off-PATH message names the dir and the fix', () => {
  const msg = formatPathNotice({ installedBinDir: 'C:\\npm-prefix', onPathFlag: false, platform: 'win32' });
  assert.match(msg, /NOT on your PATH/);
  assert.ok(msg.includes('C:\\npm-prefix'));
  assert.match(msg, /SetEnvironmentVariable/);
});

test('formatPathNotice: posix off-PATH message uses export, not the Windows idiom', () => {
  const msg = formatPathNotice({ installedBinDir: '/usr/local/bin', onPathFlag: false, platform: 'linux' });
  assert.match(msg, /NOT on your PATH/);
  assert.ok(msg.includes('/usr/local/bin'));
  assert.match(msg, /export PATH=/);
  assert.equal(/SetEnvironmentVariable/.test(msg), false);
});

test('formatPathNotice: on-PATH message is reassuring, not alarming', () => {
  const msg = formatPathNotice({ installedBinDir: '/usr/local/bin', onPathFlag: true, platform: 'linux' });
  assert.match(msg, /on your PATH/);
  assert.equal(/NOT on your PATH/.test(msg), false);
});

test('formatPathNotice: contains no em or en dash (repo style rule)', () => {
  const emDash = String.fromCharCode(8212);
  const enDash = String.fromCharCode(8211);
  for (const flag of [true, false]) {
    const msg = formatPathNotice({ installedBinDir: 'C:\\x', onPathFlag: flag, platform: 'win32' });
    assert.equal(msg.includes(emDash), false);
    assert.equal(msg.includes(enDash), false);
  }
});
