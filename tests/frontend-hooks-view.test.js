'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// hooks-view-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/hooks-view-core.mjs');

const EVENTS = [
  { name: 'PreToolUse', matcher: 'tool name (regex)', description: 'Before a tool runs.' },
  { name: 'Stop', matcher: null, description: 'When the main agent finishes a turn.' },
  { name: 'SessionStart', matcher: 'startup, resume, clear or compact', description: 'When a session starts.', http: false },
];
const PROJECTS = [{ id: 'p1', name: 'glissa', agent: 'claude-code' }];
const hook = (overrides = {}) => ({ id: 'h1', name: 'Lint', event: 'PreToolUse', matcher: 'Edit', type: 'command', command: 'npm run lint', enabled: true, ...overrides });

test('totals chips count yours, enabled and built in, and warn when every hook is off', async () => {
  const { totalsChips } = await importCore();
  const chips = totalsChips({ hooks: [hook(), hook({ id: 'h2', enabled: false })], builtin: [{}, {}, {}] });
  assert.deepEqual(chips.map((chip) => [chip.label, chip.value, chip.tone]), [['yours', '2', null], ['enabled', '1', null], ['built in', '3', null]]);
  assert.equal(totalsChips({ hooks: [hook({ enabled: false })] })[1].tone, 'warn');
  assert.equal(totalsChips(null)[0].value, '0');
});

test('sortHooks orders by catalog position then name', async () => {
  const { sortHooks } = await importCore();
  const sorted = sortHooks([hook({ id: 'b', name: 'b', event: 'Stop' }), hook({ id: 'z', name: 'z' }), hook({ id: 'a', name: 'a' }), hook({ id: 'x', name: 'x', event: 'Unknown' })], EVENTS);
  assert.deepEqual(sorted.map((entry) => entry.id), ['a', 'z', 'b', 'x']);
});

test('row text: event chip, target, type, timeout and scope', async () => {
  const core = await importCore();
  assert.equal(core.eventChipText(hook()), 'PreToolUse / Edit');
  assert.equal(core.eventChipText(hook({ matcher: undefined })), 'PreToolUse');
  assert.equal(core.targetLine(hook()), 'npm run lint');
  assert.equal(core.targetLine(hook({ type: 'http', url: 'http://x' })), 'http://x');
  assert.equal(core.typeLabel('http'), 'HTTP');
  assert.equal(core.timeoutLabel(hook()), '');
  assert.equal(core.timeoutLabel(hook({ timeout: 30 })), '30s timeout');
  assert.equal(core.scopeLabel(hook(), PROJECTS), 'All projects');
  assert.equal(core.scopeLabel(hook({ projects: ['p1', 'gone'] }), PROJECTS), 'glissa, gone');
  assert.deepEqual(core.missingProjectIds(hook({ projects: ['p1', 'gone'] }), PROJECTS), ['gone']);
  assert.equal(core.builtinLine({ event: 'PostToolUse', matcher: 'ScheduleWakeup' }), 'PostToolUse / ScheduleWakeup');
  assert.equal(core.builtinLine({ event: 'PostToolUse', matcher: 'Read' }), 'PostToolUse / Read');
});

test('matcherHint says what the matcher matches or that the event takes none', async () => {
  const { matcherHint, NO_MATCHER_TEXT } = await importCore();
  assert.equal(matcherHint(EVENTS, 'PreToolUse'), 'Matches tool name (regex). Blank matches every PreToolUse.');
  assert.equal(matcherHint(EVENTS, 'Stop'), NO_MATCHER_TEXT);
  assert.equal(matcherHint(EVENTS, 'Nope'), '');
});

test('drafts round-trip and blank optionals are omitted on the wire', async () => {
  const { emptyDraft, toDraft, fromDraft } = await importCore();
  assert.equal(emptyDraft(EVENTS).event, 'PreToolUse');
  assert.equal(emptyDraft([]).event, '');
  const full = hook({ timeout: 12, projects: ['p1'] });
  assert.deepEqual(fromDraft(toDraft(full)), full);
  const draft = { ...emptyDraft(EVENTS), name: ' New ', command: ' echo ', matcher: ' ', timeout: '' };
  assert.deepEqual(fromDraft(draft), { name: 'New', event: 'PreToolUse', type: 'command', enabled: true, command: 'echo' });
});

test('draftProblem names the first blocking problem and nothing when the draft is fine', async () => {
  const { draftProblem, emptyDraft } = await importCore();
  const good = { ...emptyDraft(EVENTS), name: 'x', command: 'echo' };
  assert.equal(draftProblem(good, EVENTS), null);
  assert.equal(draftProblem({ ...good, name: ' ' }, EVENTS), 'Give the hook a name.');
  assert.equal(draftProblem({ ...good, event: 'Nope' }, EVENTS), 'Pick an event.');
  assert.equal(draftProblem({ ...good, event: 'Stop', matcher: 'x' }, EVENTS), 'Stop takes no matcher.');
  assert.equal(draftProblem({ ...good, command: '' }, EVENTS), 'Enter the command to run.');
  assert.equal(draftProblem({ ...good, type: 'http', url: 'x' }, EVENTS), 'Enter a URL starting with http:// or https://.');
  assert.equal(draftProblem({ ...good, timeout: '0' }, EVENTS), 'Timeout must be a whole number of seconds from 1 to 600.');
  // Claude Code runs command handlers only on SessionStart, so the editor refuses before the server does.
  assert.equal(draftProblem({ ...good, event: 'SessionStart', type: 'http', url: 'http://x' }, EVENTS), 'SessionStart does not support HTTP hooks.');
});

test('the timeout ceiling comes from the report, with the server default as the fallback', async () => {
  const { draftProblem, emptyDraft, maxTimeoutOf, DEFAULT_MAX_TIMEOUT_SEC } = await importCore();
  assert.equal(maxTimeoutOf(null), DEFAULT_MAX_TIMEOUT_SEC);
  assert.equal(maxTimeoutOf({ limits: {} }), DEFAULT_MAX_TIMEOUT_SEC);
  assert.equal(maxTimeoutOf({ limits: { maxTimeoutSec: 120 } }), 120);
  const good = { ...emptyDraft(EVENTS), name: 'x', command: 'echo', timeout: '300' };
  assert.equal(draftProblem(good, EVENTS, 120), 'Timeout must be a whole number of seconds from 1 to 120.');
  assert.equal(draftProblem(good, EVENTS), null);
});

// projectsOf has one home, dom-helpers.js, and the client no longer strips a stale scope before a
// toggle: the server keeps the ids the record already held, so a dead scope survives an edit inert.
test('the core carries neither a second projectsOf nor the old scope stripper', async () => {
  const core = await importCore();
  assert.equal('projectsOf' in core, false);
  assert.equal('withKnownProjects' in core, false);
});

test('report application is ordered by requestId and an error report reads as unavailable', async () => {
  const { shouldApplyHooksReport, isHooksUnavailable, hooksErrorLine, toggledHook } = await importCore();
  assert.equal(shouldApplyHooksReport({ requestId: 'a' }, 'a'), true);
  assert.equal(shouldApplyHooksReport({ requestId: 'a' }, 'b'), false);
  assert.equal(shouldApplyHooksReport({}, 'b'), true);
  assert.equal(isHooksUnavailable({ error: 'down' }), true);
  assert.equal(isHooksUnavailable({ hooks: [] }), false);
  assert.equal(hooksErrorLine({ error: 'down' }), 'down');
  assert.equal(toggledHook(hook()).enabled, false);
});

test('no rendered string carries a dash, ellipsis or emoji character', async () => {
  const core = await importCore();
  const forbidden = /[–—…\u{1F300}-\u{1FAFF}]/u;
  for (const [key, value] of Object.entries(core)) {
    if (typeof value === 'string') assert.equal(forbidden.test(value), false, key);
  }
});

test('filterHooks matches what a row shows, and the filter only appears past the threshold', async () => {
  const { filterHooks, showsFilter, FILTER_MIN_COUNT } = await importCore();
  const hooks = [hook(), hook({ id: 'h2', name: 'Ping', event: 'Stop', matcher: undefined, type: 'http', url: 'http://ping', command: undefined })];
  assert.deepEqual(filterHooks(hooks, 'lint').map((h) => h.id), ['h1']);
  assert.deepEqual(filterHooks(hooks, 'STOP').map((h) => h.id), ['h2']);
  assert.deepEqual(filterHooks(hooks, 'http://ping').map((h) => h.id), ['h2']);
  assert.equal(filterHooks(hooks, '  ').length, 2);
  assert.equal(showsFilter(new Array(FILTER_MIN_COUNT - 1).fill(hook())), false);
  assert.equal(showsFilter(new Array(FILTER_MIN_COUNT).fill(hook())), true);
});

test('groupHooksByEvent buckets an already sorted list without reordering it', async () => {
  const { groupHooksByEvent } = await importCore();
  const groups = groupHooksByEvent([hook({ id: 'a' }), hook({ id: 'b' }), hook({ id: 'c', event: 'Stop' })]);
  assert.deepEqual(groups.map((g) => [g.event, g.hooks.map((h) => h.id)]), [['PreToolUse', ['a', 'b']], ['Stop', ['c']]]);
  assert.deepEqual(groupHooksByEvent([]), []);
});

test('settingsEntryPreview is the injector shape: matcher only when set, timeout only when the record has one', async () => {
  const { settingsEntryPreview } = await importCore();
  assert.deepEqual(JSON.parse(settingsEntryPreview(hook())), { hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }] } });
  assert.deepEqual(JSON.parse(settingsEntryPreview(hook({ event: 'Stop', matcher: undefined, type: 'http', url: 'http://x', timeout: 30 }))), { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://x', timeout: 30 }] }] } });
});

test('templates open as valid drafts and a dirty draft is told from an untouched one', async () => {
  const { HOOK_TEMPLATES, templateDraft, draftProblem, isDraftDirty, fromDraft, emptyDraft, duplicateName } = await importCore();
  const events = [...EVENTS, { name: 'PostToolUse', matcher: 'tool', description: '' }, { name: 'UserPromptSubmit', matcher: null, description: '' }];
  for (const template of HOOK_TEMPLATES) {
    const draft = templateDraft(template, events);
    assert.equal(draftProblem(draft, events), null, template.id);
    assert.equal(draft.id, null);
  }
  // An event the catalog does not carry falls back to the first one rather than an unpickable value.
  assert.equal(templateDraft({ draft: { event: 'Nope' } }, EVENTS).event, 'PreToolUse');
  const draft = { ...emptyDraft(EVENTS), name: 'x', command: 'echo' };
  const origin = fromDraft(draft);
  assert.equal(isDraftDirty(draft, origin), false);
  assert.equal(isDraftDirty({ ...draft, name: 'y' }, origin), true);
  assert.equal(duplicateName('Lint'), 'Lint copy');
});
