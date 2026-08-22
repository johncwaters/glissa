'use strict';

/*
 * The pure shell-history core (docs/plan-ingestion.md, M10): where each shell's history lives, how one
 * physical line of each format becomes a command, and which commands are worth a digest line.
 *
 * The format fixtures are the real thing, not a sketch. PSReadLine's trailing-backtick continuation and
 * the EMPTY physical line a command ending in a newline finishes on were read off a live
 * ConsoleHost_history.txt; getting either wrong publishes one command as several fragments, or glues two
 * commands together, which is exactly the shredding the terminal source's repaint filter exists to stop.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  DEFAULT_SHELLS, MAX_COMMAND_CHARS, MAX_CONTINUATION_LINES, SHELLS, createParseState, decideCommandEvent, historyLocations,
  isTrivialCommand, matchesLocation, normalizeShells, parseHistoryLines, unescapeFish,
} = require('../server/core/ingest-shell-core');

function parse(shell, lines, state = null) {
  return parseHistoryLines({ shell, lines, state: state || createParseState() });
}

function texts(shell, lines) {
  return parse(shell, lines).commands.map((command) => command.text);
}

// --- Config ----------------------------------------------------------------

test('an absent or empty shells list means the two zero-setup shells, never all four', () => {
  for (const raw of [undefined, null, [], 'powershell']) {
    assert.deepEqual(normalizeShells(raw), { shells: ['powershell', 'fish'], rejected: [] });
  }
  assert.deepEqual([...DEFAULT_SHELLS], ['powershell', 'fish']);
  assert.ok(SHELLS.includes('bash') && SHELLS.includes('zsh'), 'both are configurable, neither is default');
});

test('an explicit list names exactly the shells to tail, so fish alone drops PowerShell', () => {
  assert.deepEqual(normalizeShells(['fish']), { shells: ['fish'], rejected: [] });
  assert.deepEqual(normalizeShells(['bash', 'zsh']), { shells: ['bash', 'zsh'], rejected: [] });
});

test('pwsh and powershell are one shell, and a bad entry rides back as rejected beside the good ones', () => {
  assert.deepEqual(normalizeShells(['pwsh', 'PowerShell', 'powershell.exe']), { shells: ['powershell'], rejected: [] });
  assert.deepEqual(normalizeShells(['nushell', 'fish', 42, null]), { shells: ['fish'], rejected: ['nushell', '42', 'null'] });
});

/*
 * The silent-widening guard. This is the ONE source that must be asked for explicitly, so a list that
 * names nothing glissa knows has to cost the operator their configuration; falling back to the defaults
 * would quietly start reading two shells they never asked for.
 */
test('a non-empty list naming no known shell resolves to NOTHING, never to the defaults', () => {
  assert.deepEqual(normalizeShells(['nushell']), { shells: [], rejected: ['nushell'] });
  assert.deepEqual(normalizeShells(['nushell', 'csh', 'csh']), { shells: [], rejected: ['nushell', 'csh'] });
  assert.deepEqual(historyLocations({ shells: ['nushell'], env: { HOME: '/home/j' }, platform: 'linux' }), []);
});

// --- Discovery -------------------------------------------------------------

test('PSReadLine on Windows resolves under APPDATA, which is where both pwsh and Windows PowerShell write', () => {
  const [location] = historyLocations({ env: { APPDATA: 'C:\\Roaming' }, platform: 'win32', shells: ['powershell'] });
  assert.equal(location.dir, path.join('C:\\Roaming', 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine'));
  assert.equal(location.suffix, '_history.txt');
  assert.equal(location.name, null, 'a suffix location tails every host file in the directory');
});

test('PSReadLine off Windows resolves under XDG_DATA_HOME', () => {
  const [xdg] = historyLocations({ env: { XDG_DATA_HOME: '/x/data', HOME: '/home/j' }, platform: 'linux', shells: ['powershell'] });
  assert.equal(xdg.dir, path.join('/x/data', 'powershell', 'PSReadLine'));
  const [fallback] = historyLocations({ env: { HOME: '/home/j' }, platform: 'linux', shells: ['powershell'] });
  assert.equal(fallback.dir, path.join('/home/j', '.local', 'share', 'powershell', 'PSReadLine'));
});

test('fish is XDG aware and keeps the pre-3.0 config-dir path as a second candidate', () => {
  const found = historyLocations({ env: { HOME: '/home/j' }, platform: 'linux', shells: ['fish'] });
  assert.deepEqual(found.map((location) => location.dir), [
    path.join('/home/j', '.local', 'share', 'fish'),
    path.join('/home/j', '.config', 'fish'),
  ]);
  assert.ok(found.every((location) => location.name === 'fish_history'));
});

test('bash and zsh resolve to their default history files, and zsh keeps both spellings', () => {
  const found = historyLocations({ env: { HOME: '/home/j' }, platform: 'linux', shells: ['bash', 'zsh'] });
  assert.deepEqual(found.map((location) => path.basename(location.name)), [
    '.bash_history', '.zsh_history', '.histfile',
  ]);
});

test('HISTFILE is honored for a single posix shell and ignored when it could mean either', () => {
  const histFile = path.join('/var/hist', 'zsh');
  const single = historyLocations({ env: { HOME: '/home/j', HISTFILE: histFile }, platform: 'linux', shells: ['zsh'] });
  assert.equal(single[0].dir, path.dirname(histFile));
  assert.equal(single[0].name, 'zsh');
  assert.equal(single[0].shell, 'zsh');

  const ambiguous = historyLocations({ env: { HOME: '/home/j', HISTFILE: histFile }, platform: 'linux', shells: ['bash', 'zsh'] });
  assert.ok(!ambiguous.some((location) => location.dir === path.dirname(histFile)), 'one file cannot be two shells');
});

test('a repeated location resolves once, so a shared path is never tailed twice', () => {
  const found = historyLocations({
    env: { HOME: '/home/j', XDG_DATA_HOME: '/home/j/.config' },
    platform: 'linux',
    shells: ['fish', 'fish'],
  });
  assert.equal(found.length, 1, 'XDG_DATA_HOME pointed at the legacy dir collapses to one location');
});

test('a suffix location matches every host file, folding case, and an exact name does not', () => {
  const suffix = { shell: 'powershell', dir: 'd', suffix: '_history.txt', name: null };
  assert.equal(matchesLocation(suffix, 'ConsoleHost_history.txt'), true);
  assert.equal(matchesLocation(suffix, 'Visual Studio Code Host_history.txt'), true);
  assert.equal(matchesLocation(suffix, 'CONSOLEHOST_HISTORY.TXT'), true);
  assert.equal(matchesLocation(suffix, '_history.txt'), false, 'a bare suffix names no host');
  assert.equal(matchesLocation(suffix, 'notes.txt'), false);

  const exact = { shell: 'fish', dir: 'd', suffix: null, name: 'fish_history' };
  assert.equal(matchesLocation(exact, 'fish_history'), true);
  assert.equal(matchesLocation(exact, 'fish_history.bak'), false);
});

// --- PSReadLine ------------------------------------------------------------

test('one accepted command per line, exactly as PSReadLine appends it', () => {
  assert.deepEqual(texts('powershell', ['npm test', 'git status']), ['npm test', 'git status']);
});

test('a backtick-continued command publishes as ONE command, not one per fragment', () => {
  // Read verbatim off a live ConsoleHost_history.txt: every line but the last carries the marker.
  const lines = [
    'git branch -vv |`',
    '  Select-String ": gone]" |`',
    '  ForEach-Object {`',
    '    git branch -d $_`',
    '  }',
  ];
  const commands = parse('powershell', lines).commands;
  assert.equal(commands.length, 1);
  assert.equal(commands[0].text, 'git branch -vv |\n  Select-String ": gone]" |\n  ForEach-Object {\n    git branch -d $_\n  }');
});

test('a command ending in a newline finishes on an EMPTY line and does not swallow the next command', () => {
  const commands = parse('powershell', ['pnpm store prune`', '', 'pnpm install']).commands;
  assert.deepEqual(commands.map((command) => command.text), ['pnpm store prune\n', 'pnpm install']);
});

test('a continuation split across two reads resumes rather than publishing half a command', () => {
  const first = parse('powershell', ['foo |`', 'bar |`']);
  assert.deepEqual(first.commands, [], 'nothing is complete yet');
  const second = parseHistoryLines({ shell: 'powershell', lines: ['baz'], state: first.state });
  assert.deepEqual(second.commands.map((command) => command.text), ['foo |\nbar |\nbaz']);
});

test('a runaway continuation is finished at the line bound rather than growing without limit', () => {
  const lines = Array.from({ length: MAX_CONTINUATION_LINES * 2 }, () => 'x`');
  const commands = parse('powershell', lines).commands;
  assert.equal(commands.length, 2, 'the bound closed each entry instead of holding every line');
  assert.equal(commands[0].text.split('\n').length, MAX_CONTINUATION_LINES);
});

test('a continuation past the char bound is finished too, so a corrupt file cannot build one huge string', () => {
  const wide = `${'x'.repeat(MAX_COMMAND_CHARS / 8)}\``;
  const commands = parse('powershell', Array.from({ length: 20 }, () => wide)).commands;
  assert.ok(commands.length >= 2, 'the char bound closed the entry well before the line bound');
  assert.ok(commands[0].text.length <= MAX_COMMAND_CHARS + wide.length);
});

test('PSReadLine carries no timestamp, so the command leaves the parser without one', () => {
  assert.equal(parse('powershell', ['npm test']).commands[0].ts, null);
});

// --- fish ------------------------------------------------------------------

test('a fish entry publishes with the timestamp its when line carries', () => {
  const commands = parse('fish', ['- cmd: npm test', '  when: 1700000000']).commands;
  assert.deepEqual(commands, [{ text: 'npm test', ts: 1700000000000 }]);
});

test('fish escapes are undone in one pass, so an embedded newline and a literal backslash both survive', () => {
  assert.equal(unescapeFish('echo a\\nb'), 'echo a\nb');
  assert.equal(unescapeFish('echo "C:\\\\\\\\repo"'), 'echo "C:\\\\repo"');
  // The pass is left to right: an escaped backslash must not turn its neighbour into an escape.
  assert.equal(unescapeFish('a\\\\nb'), 'a\\nb');
  const commands = parse('fish', ['- cmd: for f in *\\n  echo $f\\nend', '  when: 1700000000']).commands;
  assert.equal(commands[0].text, 'for f in *\n  echo $f\nend');
});

test('a fish entry keeps its paths list out of the commands', () => {
  const commands = parse('fish', [
    '- cmd: git add a.txt', '  when: 1700000000', '  paths:', '    - a.txt', '- cmd: git commit', '  when: 1700000001',
  ]).commands;
  assert.deepEqual(commands.map((command) => command.text), ['git add a.txt', 'git commit']);
});

test('a fish entry whose when line has not arrived yet waits for it rather than publishing early', () => {
  const first = parse('fish', ['- cmd: npm test']);
  assert.deepEqual(first.commands, []);
  const second = parseHistoryLines({ shell: 'fish', lines: ['  when: 1700000000'], state: first.state });
  assert.deepEqual(second.commands, [{ text: 'npm test', ts: 1700000000000 }]);
});

test('a fish entry that never gets a when line is finished by the next entry starting', () => {
  const commands = parse('fish', ['- cmd: npm test', '- cmd: npm run build', '  when: 1700000000']).commands;
  assert.deepEqual(commands, [
    { text: 'npm test', ts: null },
    { text: 'npm run build', ts: 1700000000000 },
  ]);
});

// --- bash and zsh ----------------------------------------------------------

test('bash reads its epoch comment as the timestamp and never as a command', () => {
  const commands = parse('bash', ['#1700000000', 'npm test', 'npm run build']).commands;
  assert.deepEqual(commands, [
    { text: 'npm test', ts: 1700000000000 },
    { text: 'npm run build', ts: null },
  ]);
});

test('a short bash comment is a command, not a mistimestamped one', () => {
  assert.deepEqual(texts('bash', ['#5 this is a note']), ['#5 this is a note']);
});

test('zsh strips its extended-history prefix and keeps the command', () => {
  const commands = parse('zsh', [': 1700000000:0;npm test', ': 1700000005:2;git push']).commands;
  assert.deepEqual(commands, [
    { text: 'npm test', ts: 1700000000000 },
    { text: 'git push', ts: 1700000005000 },
  ]);
});

test('zsh without extended history is still one command per line', () => {
  assert.deepEqual(texts('zsh', ['npm test', 'git push']), ['npm test', 'git push']);
});

test('a backslash-continued zsh entry publishes as one command with its head timestamp', () => {
  const commands = parse('zsh', [': 1700000000:0;for f in *; do\\', '  echo $f\\', 'done']).commands;
  assert.deepEqual(commands, [{ text: 'for f in *; do\n  echo $f\ndone', ts: 1700000000000 }]);
});

test('a continuation line that looks like an extended-history head is read as text', () => {
  const commands = parse('zsh', ['echo one\\', ': 1700000000:0;not a header']).commands;
  assert.deepEqual(commands.map((command) => command.text), ['echo one\n: 1700000000:0;not a header']);
});

test('an unknown shell parses to nothing rather than guessing at a format', () => {
  assert.deepEqual(parse('nushell', ['npm test']).commands, []);
});

// --- Noise rules -----------------------------------------------------------

test('bare navigation and screen clearing are trivial; the same verb with arguments is not', () => {
  for (const trivial of ['', '  ', 'ls', 'LS', 'cd', 'cd ..', 'pwd', 'cls', 'clear', 'dir', 'exit', 'history']) {
    assert.equal(isTrivialCommand(trivial), true, `expected trivial: ${trivial}`);
  }
  for (const real of ['ls -R src', 'cd C:\\repo', 'clear-host -force', 'npm test', 'git log --oneline']) {
    assert.equal(isTrivialCommand(real), false, `expected real: ${real}`);
  }
});

test('a trivial command publishes nothing at all', () => {
  const decided = decideCommandEvent({ shell: 'powershell', command: { text: 'cls', ts: null }, now: 5 });
  assert.equal(decided.event, null);
});

test('a consecutive duplicate collapses, because PSReadLine records every Enter press', () => {
  const first = decideCommandEvent({ shell: 'powershell', command: { text: 'npm test' }, previous: null, now: 5 });
  assert.ok(first.event, 'the first one publishes');
  const repeat = decideCommandEvent({ shell: 'powershell', command: { text: 'npm test' }, previous: first.previous, now: 6 });
  assert.equal(repeat.event, null);
  // Only CONSECUTIVE repeats collapse: a command run again after something else is real activity.
  const between = decideCommandEvent({ shell: 'powershell', command: { text: 'git status -sb' }, previous: repeat.previous, now: 7 });
  const again = decideCommandEvent({ shell: 'powershell', command: { text: 'npm test' }, previous: between.previous, now: 8 });
  assert.ok(again.event, 'the same command after another one publishes again');
});

test('a published event is machine scope, kind command, and names its shell', () => {
  const { event } = decideCommandEvent({ shell: 'fish', command: { text: 'npm test', ts: 1700000000000 }, now: 5 });
  assert.equal(event.source, 'shellHistory');
  assert.equal(event.kind, 'command');
  assert.deepEqual(event.scope, { root: null, sessionId: null }, 'a history file records no cwd');
  assert.equal(event.summary, 'fish: npm test');
  assert.deepEqual(event.detail, { shell: 'fish' });
  assert.equal(event.ts, 1700000000000);
});

test('a command with no timestamp of its own is stamped with arrival time', () => {
  const { event } = decideCommandEvent({ shell: 'powershell', command: { text: 'npm test', ts: null }, now: 4242 });
  assert.equal(event.ts, 4242);
});

/*
 * The summary leaves RAW on purpose. normalizeEvent scrubs, THEN folds, THEN slices, and that order is
 * what lets the scrub see a whole quoted value; folding or slicing here would run ahead of it. The fold
 * is asserted where it actually happens, at ring level in tests/ingest-shell-history.test.js.
 */
test('a multi-line command leaves the core unfolded, carrying its line count for the reader', () => {
  const { event } = decideCommandEvent({
    shell: 'powershell', command: { text: 'git branch -vv |\n  ForEach-Object {\n  }' }, now: 5,
  });
  assert.equal(event.summary, 'powershell: git branch -vv |\n  ForEach-Object {\n  }');
  assert.equal(event.detail.lines, 3);
});

test('a long command is handed on whole, so the scrub can see a secret past any prefix length', () => {
  const secret = `echo ${'a'.repeat(500)} --password "hunter two three"`;
  const { event } = decideCommandEvent({ shell: 'powershell', command: { text: secret }, now: 5 });
  assert.ok(event.summary.endsWith('--password "hunter two three"'), 'nothing here may slice the value');
  assert.equal(event.summary.length, secret.length + 'powershell: '.length);
});

test('two long commands that first differ past a long shared prefix are two commands, not a repeat', () => {
  const prefix = 'npm run build -- '.padEnd(400, 'x');
  const first = decideCommandEvent({ shell: 'powershell', command: { text: `${prefix} --mode production` }, now: 5 });
  assert.ok(first.event, 'the first publishes');
  const second = decideCommandEvent({
    shell: 'powershell', command: { text: `${prefix} --mode staging` }, previous: first.previous, now: 6,
  });
  assert.ok(second.event, 'the duplicate gate compares the whole command, not a prefix of it');
  assert.ok(second.event.summary.endsWith('--mode staging'));
});
