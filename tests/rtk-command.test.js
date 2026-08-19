'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildRtkHookEntry, resolveRtkPath } = require('../session/core/rtk-command');

function fsWithFiles(files) {
  const normalized = new Set(files.map((file) => path.resolve(file)));
  return {
    statSync(candidate) {
      const resolved = path.resolve(candidate);
      if (!normalized.has(resolved)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true };
    },
  };
}

test('buildRtkHookEntry emits the Claude Bash PreToolUse command without quoting a plain path', () => {
  assert.deepEqual(buildRtkHookEntry('C:\\tools\\rtk.exe'), {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'C:\\tools\\rtk.exe hook claude' }],
  });
});

test('buildRtkHookEntry quotes a path containing spaces', () => {
  assert.deepEqual(buildRtkHookEntry('C:\\Program Files\\rtk\\rtk.exe'), {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: '"C:\\Program Files\\rtk\\rtk.exe" hook claude' }],
  });
});

test('resolveRtkPath prefers the Glissa managed bin directory before PATH', () => {
  const homeDir = path.join('C:\\Users', 'johnw');
  const bundled = path.join(homeDir, '.glissa', 'bin', 'rtk.exe');
  const resolved = resolveRtkPath({
    homeDir,
    platform: 'win32',
    fsApi: fsWithFiles([bundled]),
    exec: () => {
      throw new Error('PATH should not be queried');
    },
  });
  assert.equal(resolved, path.resolve(bundled));
});

test('resolveRtkPath probes extensionless Glissa bin candidate for non-Windows installs', () => {
  const homeDir = '/home/jw';
  const bundled = path.join(homeDir, '.glissa', 'bin', 'rtk');
  const resolved = resolveRtkPath({
    homeDir,
    platform: 'linux',
    fsApi: fsWithFiles([bundled]),
    exec: () => {
      throw new Error('PATH should not be queried');
    },
  });
  assert.equal(resolved, path.resolve(bundled));
});

test('resolveRtkPath falls back to the first PATH match', () => {
  const resolved = resolveRtkPath({
    homeDir: 'C:\\Users\\johnw',
    platform: 'win32',
    fsApi: fsWithFiles([]),
    exec: () => 'C:\\tools\\rtk.exe\r\nC:\\other\\rtk.exe\r\n',
  });
  assert.equal(resolved, path.resolve('C:\\tools\\rtk.exe'));
});

test('resolveRtkPath returns null when neither managed bin nor PATH resolves', () => {
  const resolved = resolveRtkPath({
    homeDir: 'C:\\Users\\johnw',
    platform: 'win32',
    fsApi: fsWithFiles([]),
    exec: () => {
      throw new Error('not found');
    },
  });
  assert.equal(resolved, null);
});
