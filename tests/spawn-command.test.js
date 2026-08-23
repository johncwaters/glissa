'use strict';

// Unit tests for the pure spawn-command builder and the extension classifier.
// These exercise every spawn branch deterministically, without spawning a PTY.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSpawnCommand, classifyClaudeKind } = require('../session/sessions');
const { dedupePathMatches, resolveClaudeCommand } = require('../session/core/spawn-command');

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

// A PATH listing ~/.local/bin twice made `which -a claude` report one install twice, and the boot
// warning then listed the identical path twice as if two claudes were shadowing each other.
test('dedupePathMatches collapses a path repeated by a duplicated PATH entry', () => {
  const p = '/home/jwaters/.local/bin/claude';
  assert.deepEqual(dedupePathMatches([p, p], 'linux'), [p], 'one real install, one entry');
  assert.deepEqual(
    dedupePathMatches([p, '/usr/local/bin/claude', p], 'linux'),
    [p, '/usr/local/bin/claude'],
    'genuine shadowing survives, order preserved so the first match still wins',
  );
});

// Survivors come back NORMALIZED, so the form compared is the form handed to the spawn and the
// warning. Normalization follows the platform ARGUMENT, never the OS the test happens to run on.
test('dedupePathMatches normalizes separators, trailing slashes and surrounding space', () => {
  assert.deepEqual(
    dedupePathMatches(['/home/u/.local/bin/claude', '/home/u/.local//bin/claude', '  /home/u/.local/bin/claude  '], 'linux'),
    ['/home/u/.local/bin/claude'],
  );
  assert.deepEqual(dedupePathMatches(['/opt/bin/', '/opt/bin'], 'linux'), ['/opt/bin'],
    'the canonical form comes back, not the raw first spelling');
  assert.deepEqual(dedupePathMatches(['C:\\a\\\\b\\claude.exe'], 'win32'), ['C:\\a\\b\\claude.exe']);
});

test('dedupePathMatches is case-insensitive on win32 only, and preserves the case it keeps', () => {
  const a = 'C:\\Users\\johnw\\.local\\bin\\claude.exe';
  const b = 'c:\\users\\johnw\\.local\\bin\\CLAUDE.EXE';
  assert.deepEqual(dedupePathMatches([a, b], 'win32'), [a], 'one file, Windows is case-insensitive');
  assert.deepEqual(dedupePathMatches([b, a], 'win32'), [b], 'first spelling wins, case untouched');
  assert.equal(dedupePathMatches(['/a/claude', '/A/Claude'], 'linux').length, 2, 'posix paths are case-sensitive');
});

test('dedupePathMatches leaves an empty or single-entry list alone', () => {
  assert.deepEqual(dedupePathMatches([], 'linux'), []);
  assert.deepEqual(dedupePathMatches(['/usr/bin/claude'], 'linux'), ['/usr/bin/claude']);
});

test('resolveClaudeCommand falls back to command -v when which is missing on posix', () => {
  const commands = [];
  const resolved = resolveClaudeCommand({
    platform: 'linux',
    exec(command) {
      commands.push(command);
      if (command === 'which -a claude') throw new Error('which missing');
      assert.equal(command, 'sh -c "command -v claude"');
      return '/home/u/.local/bin/claude\n';
    },
  });

  assert.deepEqual(commands, ['which -a claude', 'sh -c "command -v claude"']);
  assert.deepEqual(resolved, { path: '/home/u/.local/bin/claude', kind: 'shim' });
});

test('resolveClaudeCommand falls back to command -v when which returns no matches', () => {
  const commands = [];
  const resolved = resolveClaudeCommand({
    platform: 'linux',
    exec(command) {
      commands.push(command);
      if (command === 'which -a claude') return '\n';
      return '/usr/local/bin/claude\n';
    },
  });

  assert.deepEqual(commands, ['which -a claude', 'sh -c "command -v claude"']);
  assert.deepEqual(resolved, { path: '/usr/local/bin/claude', kind: 'shim' });
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

test('packArgs land between the settings block and claudeArgs, on both spawn forms', () => {
  const PACKS = ['--add-dir', 'C:/Users/johnw/.glissa/packs/built/company-context/current'];
  const direct = buildSpawnCommand({
    platform: 'win32',
    resolved: { path: 'C:/a/claude.exe', kind: 'exe' },
    settingsArgs: SETTINGS,
    packArgs: PACKS,
    claudeArgs: [...DANGER, 'THE PROMPT'],
  });
  assert.deepEqual(direct.args, [...SETTINGS, ...PACKS, ...DANGER, 'THE PROMPT']);
  assert.equal(direct.args[direct.args.length - 1], 'THE PROMPT', 'the prompt positional stays last');

  const shim = buildSpawnCommand({
    platform: 'win32',
    resolved: { path: 'C:/a/claude.cmd', kind: 'shim' },
    settingsArgs: SETTINGS,
    packArgs: PACKS,
    claudeArgs: DANGER,
  });
  assert.deepEqual(shim.args, ['/c', 'claude', ...SETTINGS, ...PACKS, ...DANGER]);
});

test('omitting packArgs reproduces the pre-pack argv exactly', () => {
  const before = buildSpawnCommand({
    platform: 'linux',
    resolved: { path: '/usr/local/bin/claude', kind: 'shim' },
    settingsArgs: SETTINGS,
    claudeArgs: DANGER,
  });
  assert.deepEqual(before.args, [...SETTINGS, ...DANGER]);
});
