'use strict';

// Unit tests for the pure spawn-command builder and the extension classifier.
// These exercise every spawn branch deterministically, without spawning a PTY.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSpawnCommand, classifyClaudeKind } = require('../sessions');

const SETTINGS = ['--settings', 'C:\\tmp\\glissa\\settings.json'];
const DANGER = ['--dangerously-skip-permissions'];

test('posix -> bare claude, args preserved in order', () => {
  const { file, args } = buildSpawnCommand({
    platform: 'linux',
    resolved: { path: '/usr/local/bin/claude', kind: 'shim' },
    settingsArgs: SETTINGS,
    claudeArgs: DANGER,
  });
  assert.equal(file, 'claude');
  assert.deepEqual(args, [...SETTINGS, ...DANGER]);
});

test('win + .exe -> direct absolute path, no cmd.exe and no /c', () => {
  const p = 'C:\\Users\\johnw\\.local\\bin\\claude.exe';
  const { file, args } = buildSpawnCommand({
    platform: 'win32',
    resolved: { path: p, kind: 'exe' },
    settingsArgs: SETTINGS,
    claudeArgs: DANGER,
  });
  assert.equal(file, p);
  assert.deepEqual(args, [...SETTINGS, ...DANGER]);
  assert.ok(!args.includes('/c'), 'must not contain the cmd /c token');
  assert.notEqual(file, 'cmd.exe');
});

test('win + .com (classified exe) -> direct path', () => {
  const p = 'C:\\tools\\claude.com';
  const { file } = buildSpawnCommand({
    platform: 'win32',
    resolved: { path: p, kind: 'exe' },
    settingsArgs: SETTINGS,
    claudeArgs: [],
  });
  assert.equal(file, p);
});

test('win + .cmd shim -> cmd.exe /c claude (historical form unchanged)', () => {
  const { file, args } = buildSpawnCommand({
    platform: 'win32',
    resolved: { path: 'C:\\Users\\johnw\\AppData\\Roaming\\npm\\claude.cmd', kind: 'shim' },
    settingsArgs: SETTINGS,
    claudeArgs: DANGER,
  });
  assert.equal(file, 'cmd.exe');
  assert.deepEqual(args, ['/c', 'claude', ...SETTINGS, ...DANGER]);
});

test('win + unresolved -> cmd.exe /c claude', () => {
  const { file, args } = buildSpawnCommand({
    platform: 'win32',
    resolved: { path: null, kind: 'unresolved' },
    settingsArgs: [],
    claudeArgs: [],
  });
  assert.equal(file, 'cmd.exe');
  assert.deepEqual(args, ['/c', 'claude']);
});

test('win + missing resolved object -> cmd.exe fallback (defensive)', () => {
  const { file, args } = buildSpawnCommand({
    platform: 'win32',
    resolved: undefined,
    settingsArgs: [],
    claudeArgs: [],
  });
  assert.equal(file, 'cmd.exe');
  assert.deepEqual(args, ['/c', 'claude']);
});

test('win + spaced exe path stays a single file arg, never word-split', () => {
  const p = 'C:\\Program Files\\Anthropic\\claude.exe';
  const { file, args } = buildSpawnCommand({
    platform: 'win32',
    resolved: { path: p, kind: 'exe' },
    settingsArgs: SETTINGS,
    claudeArgs: [],
  });
  assert.equal(file, p);
  assert.ok(args.every((a) => !a.toLowerCase().includes('claude.exe')),
    'exe path must not leak into args');
  assert.ok(args.every((a) => !a.includes('Program')),
    'spaced path must not be split into separate args');
});

test('no dangerous flag passthrough when claudeArgs is empty', () => {
  const { args } = buildSpawnCommand({
    platform: 'win32',
    resolved: { path: 'C:\\x\\claude.exe', kind: 'exe' },
    settingsArgs: SETTINGS,
    claudeArgs: [],
  });
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(args, SETTINGS);
});

test('empty inputs default safely (no crash, posix bare claude)', () => {
  const { file, args } = buildSpawnCommand({ platform: 'linux', resolved: null });
  assert.equal(file, 'claude');
  assert.deepEqual(args, []);
});

test('classifyClaudeKind maps extensions correctly', () => {
  assert.equal(classifyClaudeKind('C:\\a\\claude.exe'), 'exe');
  assert.equal(classifyClaudeKind('C:\\a\\claude.EXE'), 'exe');
  assert.equal(classifyClaudeKind('C:\\a\\claude.com'), 'exe');
  assert.equal(classifyClaudeKind('C:\\a\\claude.cmd'), 'shim');
  assert.equal(classifyClaudeKind('C:\\a\\claude.bat'), 'shim');
  assert.equal(classifyClaudeKind('C:\\a\\claude.ps1'), 'shim');
  assert.equal(classifyClaudeKind('/usr/local/bin/claude'), 'shim');
  // Extensionless binary inside a dotted directory: the dot belongs to a path
  // segment, not the filename, so this must NOT be mistaken for an extension.
  assert.equal(classifyClaudeKind('C:\\Users\\johnw\\.local\\bin\\claude'), 'shim');
  assert.equal(classifyClaudeKind('/home/u/.local/bin/claude'), 'shim');
  assert.equal(classifyClaudeKind('C:\\Program Files\\x\\claude.exe'), 'exe');
  assert.equal(classifyClaudeKind(null), 'unresolved');
  assert.equal(classifyClaudeKind(''), 'unresolved');
});
