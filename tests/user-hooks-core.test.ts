// The Hooks tab's pure core: what a record must look like to be persisted, how a bad hand edit is
// dropped rather than crashing a spawn, which hooks one project's spawn carries, and how they land in
// a Claude Code settings `hooks` block AFTER Glissa's own entries.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as core from '../session/core/user-hooks-core.ts';
import type { HookEventEntry, HookInput, HooksBlock, UserHook } from '../session/core/user-hooks-core.ts';

type NormalizeResult = ReturnType<typeof core.normalizeHook>;

const valid = (overrides: HookInput = {}): HookInput => ({ name: 'Lint', event: 'PostToolUse', matcher: 'Edit|Write', type: 'command', command: 'npm run lint', ...overrides });

// The result is a discriminated union, so a test that wants one arm says so and fails loudly otherwise.
function refusalError(result: NormalizeResult): string {
  if (result.ok) assert.fail('expected the record to be refused');
  return result.error;
}

function acceptedHook(result: NormalizeResult): UserHook {
  if (!result.ok) assert.fail(result.error);
  return result.hook;
}

function catalogEntry(name: string): HookEventEntry {
  const entry = core.HOOK_EVENT_CATALOG.find((candidate) => candidate.name === name);
  if (!entry) assert.fail(`${name} is missing from the hook event catalog`);
  return entry;
}

test('normalizeHook trims, defaults enabled and omits blank optionals', () => {
  const hook = acceptedHook(core.normalizeHook(valid({ name: '  Lint  ', matcher: '', timeout: '', projects: [] }), { id: 'h1' }));
  assert.deepEqual(hook, { id: 'h1', name: 'Lint', event: 'PostToolUse', type: 'command', enabled: true, command: 'npm run lint' });
});

test('normalizeHook names the first thing wrong', () => {
  const cases: [HookInput | null, string][] = [
    [{ ...valid(), name: '' }, 'name is required'],
    [{ ...valid(), event: 'Nope' }, 'Nope is not a hook event'],
    [{ ...valid(), event: '' }, 'event is required'],
    [{ ...valid(), type: 'prompt' }, 'type must be command or http'],
    [{ ...valid(), event: 'Stop', matcher: 'x' }, 'Stop takes no matcher'],
    [{ ...valid(), command: ' ' }, 'command is required'],
    [{ ...valid({ type: 'http', url: 'ftp://x' }) }, 'url must start with http:// or https://'],
    [{ ...valid(), timeout: 0 }, 'timeout must be a whole number of seconds from 1 to 600'],
    [{ ...valid(), timeout: 2.5 }, 'timeout must be a whole number of seconds from 1 to 600'],
    [{ ...valid(), projects: 'p1' }, 'projects must be a list of project ids'],
    [{ ...valid(), enabled: 'false' }, 'enabled must be true or false'],
    [{ ...valid(), matcher: ['Bash'] }, 'matcher must be a string'],
    [{ ...valid(), timeout: true }, 'timeout must be a whole number of seconds from 1 to 600'],
    [{ ...valid({ type: 'http', url: 'http://x', event: 'SessionStart' }) }, 'SessionStart does not support HTTP hooks'],
  ];
  for (const [input, error] of cases) {
    assert.equal(refusalError(core.normalizeHook(input, { id: 'h1' })), error, JSON.stringify(input));
  }
  assert.equal(refusalError(core.normalizeHook(valid(), { id: 'bad id!' })), 'hook id is invalid');
  assert.equal(refusalError(core.normalizeHook(null, { id: 'h1' })), 'hook must be an object');
});

// Coercing a malformed optional is worse than refusing it: `enabled: 'false'` would read as ON, a
// non-string matcher would erase a Bash-only guard's scope and leave it firing on every tool, and
// `timeout: true` would become a one second deadline.
test('a malformed optional is refused rather than coerced, and readStoredHooks drops that record', () => {
  const timeoutError = 'timeout must be a whole number of seconds from 1 to 600';
  assert.equal(refusalError(core.normalizeHook(valid({ enabled: 'false' }), { id: 'h1' })), 'enabled must be true or false');
  assert.equal(refusalError(core.normalizeHook(valid({ enabled: 0 }), { id: 'h1' })), 'enabled must be true or false');
  assert.equal(refusalError(core.normalizeHook(valid({ matcher: { source: 'Bash' } }), { id: 'h1' })), 'matcher must be a string');
  assert.equal(refusalError(core.normalizeHook(valid({ timeout: {} }), { id: 'h1' })), timeoutError);
  assert.equal(refusalError(core.normalizeHook(valid({ timeout: [30] }), { id: 'h1' })), timeoutError);
  // What the strict reads still take: absent enabled means on, and a numeric string is still a timeout.
  assert.equal(acceptedHook(core.normalizeHook(valid({ enabled: undefined }), { id: 'h1' })).enabled, true);
  assert.equal(acceptedHook(core.normalizeHook(valid({ enabled: false }), { id: 'h1' })).enabled, false);
  assert.equal(acceptedHook(core.normalizeHook(valid({ timeout: '30' }), { id: 'h1' })).timeout, 30);
  const stored = [
    { id: 'ok', ...valid() },
    { id: 'strEnabled', ...valid({ enabled: 'false' }) },
    { id: 'objMatcher', ...valid({ matcher: {} }) },
    { id: 'boolTimeout', ...valid({ timeout: true }) },
  ];
  assert.deepEqual(core.readStoredHooks(stored).map((hook) => hook.id), ['ok']);
});

test('normalizeHook refuses a project id the config does not hold, and dedupes the ones it does', () => {
  const known = new Set(['p1', 'p2']);
  assert.equal(refusalError(core.normalizeHook(valid({ projects: ['p9'] }), { id: 'h1', knownProjectIds: known })), 'Unknown project p9');
  const ok = acceptedHook(core.normalizeHook(valid({ projects: ['p1', 'p1', 'p2'] }), { id: 'h1', knownProjectIds: known }));
  assert.deepEqual(ok.projects, ['p1', 'p2']);
});

test('an http hook keeps its url and drops any command, and vice versa', () => {
  const http = acceptedHook(core.normalizeHook(valid({ type: 'http', url: 'http://127.0.0.1:9/x', command: 'ignored' }), { id: 'h1' }));
  assert.equal(http.url, 'http://127.0.0.1:9/x');
  assert.equal('command' in http, false);
  const command = acceptedHook(core.normalizeHook(valid({ url: 'http://x' }), { id: 'h1' }));
  assert.equal('url' in command, false);
});

test('readStoredHooks drops unreadable, duplicate and invalid records instead of throwing', () => {
  const stored = [
    null,
    'x',
    { id: 'h1', ...valid() },
    { id: 'h1', ...valid({ name: 'dup' }) },
    { id: 'bad id', ...valid() },
    { id: 'h2', ...valid({ event: 'Gone' }) },
    { id: 'h3', ...valid({ enabled: false }) },
  ];
  const hooks = core.readStoredHooks(stored);
  assert.deepEqual(hooks.map((hook) => hook.id), ['h1', 'h3']);
  assert.equal(hooks[1].enabled, false);
  assert.deepEqual(core.readStoredHooks(undefined), []);
  assert.deepEqual(core.readStoredHooks({}), []);
});

test('upsertHook replaces in place and appends when new; removeHook filters by id', () => {
  const a = { id: 'a', ...valid(), enabled: true };
  const b = { id: 'b', ...valid(), enabled: true };
  const list = core.upsertHook([a, b], { ...a, name: 'A2' });
  assert.deepEqual(list.map((hook) => hook.name), ['A2', 'Lint']);
  assert.equal(core.upsertHook([a], b).length, 2);
  assert.deepEqual(core.removeHook([a, b], 'a'), [b]);
});

// The list edits run over the raw stored array, so a record this build cannot normalize is carried
// through an unrelated edit rather than dropped by the write that rewrites the list.
test('the list edits keep a record the core cannot normalize', () => {
  const future = { id: 'future', name: 'f', event: 'NotYetKnown', type: 'command', command: 'x', enabled: true };
  const a = { id: 'a', ...valid(), enabled: true };
  assert.deepEqual(core.rawStoredHooks([future, a]), [future, a]);
  assert.deepEqual(core.rawStoredHooks(undefined), []);
  assert.deepEqual(core.upsertHook(core.rawStoredHooks([future, a]), { ...a, name: 'A2' }), [future, { ...a, name: 'A2' }]);
  assert.deepEqual(core.removeHook(core.rawStoredHooks([future, a]), 'a'), [future]);
});

test('hooksForProject carries enabled global hooks and enabled hooks naming the project', () => {
  const stored = [
    { id: 'g', ...valid(), enabled: true },
    { id: 'off', ...valid(), enabled: false },
    { id: 'p1only', ...valid(), enabled: true, projects: ['p1'] },
    { id: 'p2only', ...valid(), enabled: true, projects: ['p2'] },
  ];
  assert.deepEqual(core.hooksForProject(stored, 'p1').map((hook) => hook.id), ['g', 'p1only']);
  assert.deepEqual(core.hooksForProject(stored, null).map((hook) => hook.id), ['g']);
});

test('appendUserHooks lands after existing entries and writes a timeout only when the record has one', () => {
  const block: HooksBlock = { Stop: [{ hooks: [{ type: 'http', url: 'glissa' }] }] };
  const hooks: UserHook[] = [
    { id: 'a', name: 'a', event: 'Stop', type: 'command', command: 'say done', enabled: true },
    { id: 'b', name: 'b', event: 'PreToolUse', matcher: 'Bash', type: 'http', url: 'http://x', timeout: 30, enabled: true },
  ];
  core.appendUserHooks(block, hooks);
  assert.deepEqual(block.Stop, [
    { hooks: [{ type: 'http', url: 'glissa' }] },
    { hooks: [{ type: 'command', command: 'say done' }] },
  ]);
  assert.deepEqual(block.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'http', url: 'http://x', timeout: 30 }] }]);
});

test('the event catalog is unique and every entry says what its matcher matches or that it has none', () => {
  const names = core.HOOK_EVENT_CATALOG.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  for (const entry of core.HOOK_EVENT_CATALOG) {
    assert.ok(entry.matcher === null || typeof entry.matcher === 'string');
    assert.ok(entry.description.length > 0);
    assert.ok(entry.http === undefined || entry.http === false);
  }
  // The events current Claude Code fires that an operator can subscribe to; a catalog missing one is a
  // hook the tab cannot offer at all.
  for (const name of ['Setup', 'UserPromptExpansion', 'PostToolBatch', 'MessageDisplay', 'DirectoryAdded', 'PreModelSwitch', 'PostModelSwitch']) {
    assert.ok(names.includes(name), name);
  }
  // Claude Code matches a FileChanged hook against the literal file name, and runs command handlers
  // only on SessionStart, so the catalog has to say both.
  const fileChangedMatcher = catalogEntry('FileChanged').matcher;
  assert.ok(fileChangedMatcher);
  assert.match(fileChangedMatcher, /literally/);
  assert.equal(catalogEntry('InstructionsLoaded').matcher, 'load reason (regex)');
  assert.equal(catalogEntry('SessionStart').http, false);
  // Setup takes its trigger as a matcher and runs command handlers only; the four events that also take
  // one must say so, or the picker refuses a matcher Claude Code accepts.
  assert.equal(catalogEntry('Setup').http, false);
  assert.equal(catalogEntry('Setup').matcher, 'init, maintenance or resume');
  assert.equal(catalogEntry('UserPromptExpansion').matcher, 'expansion source (regex)');
  assert.equal(catalogEntry('DirectoryAdded').matcher, 'directory path (regex)');
  assert.equal(catalogEntry('PreModelSwitch').matcher, 'model name (regex)');
  assert.equal(catalogEntry('PostModelSwitch').matcher, 'model name (regex)');
  assert.match(catalogEntry('PreToolUse').description, /Exit code 2 blocks the call/);
});

test('an http url is capped like every other field', () => {
  const url = `http://x/${'a'.repeat(2000)}`;
  assert.equal(refusalError(core.normalizeHook(valid({ type: 'http', url }), { id: 'h1' })), 'url is longer than 2000 characters');
});
