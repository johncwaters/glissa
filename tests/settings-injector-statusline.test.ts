// The managed statusLine block in a per-session settings file. Two things make this fragile enough to
// pin: Claude Code runs the command through git-bash on Windows (a backslash path dies silently with
// exit 127), and a statusLine here REPLACES the operator's global one rather than adding to it, so the
// command has to carry their own command along or the feature deletes their HUD.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildHookSettings,
  buildStatuslineCommand,
  readUserStatuslineCommand,
  RELAY_PATH,
  NO_CHAIN,
} from '../detection/settings-injector.ts';

const BASE = { port: 4321, glissaId: 'sess-1', token: 'tok-abc' };

let tmpDir = '';

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-statusline-'));
});

test.after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function userSettings(contents: string | object) {
  const file = path.join(tmpDir, `settings-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return file;
}

test('disabled: no statusLine key at all, and the rest of the file is untouched', () => {
  const off = buildHookSettings({ ...BASE });
  assert.equal('statusLine' in off, false);
  const explicit = buildHookSettings({ ...BASE, planLimits: false });
  assert.equal('statusLine' in explicit, false);
  // The opted-out file has to stay byte-identical to the pre-statusline one.
  assert.equal(JSON.stringify(off), JSON.stringify(explicit));
});

test('enabled: a command-type statusLine pointing at the relay with the session token in the URL', () => {
  const settings = buildHookSettings({ ...BASE, planLimits: true, userSettingsPath: path.join(tmpDir, 'nope.json') });
  assert.ok(settings.statusLine);
  assert.equal(settings.statusLine.type, 'command');
  const command = settings.statusLine.command;
  assert.match(command, /^node /);
  assert.ok(command.includes('statusline-relay.ts'), 'runs the relay');
  assert.ok(command.includes('/hook/sess-1/statusline'), 'posts to the statusline hook route');
  assert.ok(command.includes('t=tok-abc'), 'carries the per-session bearer token');
  assert.ok(command.includes('http://127.0.0.1:4321/'), 'loopback only');
  // Nothing to chain: the marker, not an empty argument.
  assert.ok(command.endsWith(`'${NO_CHAIN}'`), `ends with the no-chain marker: ${command}`);
});

test('enabled: every path in the command is forward-slashed for git-bash', () => {
  const settings = buildHookSettings({
    ...BASE,
    planLimits: true,
    relayPath: 'C:\\Users\\johnw\\glissa\\session\\statusline-relay.ts',
    userSettingsPath: path.join(tmpDir, 'nope.json'),
  });
  assert.ok(settings.statusLine);
  const command = settings.statusLine.command;
  assert.equal(command.includes('\\'), false, `no backslash survives: ${command}`);
  assert.ok(command.includes('C:/Users/johnw/glissa/session/statusline-relay.ts'));
});

test('the real relay path resolves to a file that exists', () => {
  assert.ok(fs.existsSync(RELAY_PATH), `${RELAY_PATH} exists`);
});

test('chaining: the operator command is base64 in argv and decodes back verbatim', () => {
  const hud = 'node C:/Users/johnw/.claude/hud/hud.mjs';
  const settings = buildHookSettings({
    ...BASE,
    planLimits: true,
    userSettingsPath: userSettings({ statusLine: { type: 'command', command: hud } }),
  });
  assert.ok(settings.statusLine);
  const command = settings.statusLine.command;
  const encoded = (command.split(' ').pop() ?? '').replace(/'/g, '');
  assert.notEqual(encoded, NO_CHAIN);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), hud);
  // Base64 is why a HUD command full of quotes and metacharacters needs no extra escaping here.
  assert.equal(command.includes(hud), false, 'the raw command never appears unencoded');
});

test('chaining: a command with quotes and metacharacters survives the round trip', () => {
  const nasty = `bash -c 'echo "a b" | tr a A' && printf '%s' done`;
  const encoded = (buildStatuslineCommand({ postUrl: 'http://127.0.0.1:1/x', userCommand: nasty })
    .split(' ')
    .pop() ?? '')
    .replace(/'/g, '');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), nasty);
});

test('readUserStatuslineCommand: best effort, and every failure means nothing to chain', () => {
  assert.equal(readUserStatuslineCommand(path.join(tmpDir, 'absent.json')), null);
  assert.equal(readUserStatuslineCommand(userSettings('{ not json')), null);
  assert.equal(readUserStatuslineCommand(userSettings({})), null);
  assert.equal(readUserStatuslineCommand(userSettings({ statusLine: null })), null);
  assert.equal(readUserStatuslineCommand(userSettings({ statusLine: { type: 'command' } })), null);
  assert.equal(readUserStatuslineCommand(userSettings({ statusLine: { type: 'command', command: '   ' } })), null);
  // Only a command-type entry can be chained by running it.
  assert.equal(readUserStatuslineCommand(userSettings({ statusLine: { type: 'static', command: 'x' } })), null);
  assert.equal(
    readUserStatuslineCommand(userSettings({ statusLine: { type: 'command', command: ' node hud.mjs ' } })),
    'node hud.mjs',
  );
});

test('the URL is single-quoted, so its query string cannot be reinterpreted by the shell', () => {
  const command = buildStatuslineCommand({
    relayPath: '/r/relay.js',
    postUrl: 'http://127.0.0.1:9/hook/a/statusline?t=abc',
  });
  assert.ok(command.includes(`'http://127.0.0.1:9/hook/a/statusline?t=abc'`));
});
