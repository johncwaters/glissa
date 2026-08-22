'use strict';

/*
 * The pure halves of the agent-log source (docs/plan-ingestion.md, M7): the shared tail state that
 * composes usage-scan-core's offset rules, and the vendor line mapping that turns one transcript line
 * into at most a few summarized events.
 *
 * The load-bearing rule pinned here is the EOF start: a tail that began at zero would replay a finished
 * conversation of hundreds of megabytes into a ring built for recent activity.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_CATCH_UP_BYTES, applyRead, createTailState, fileIdentity, isActiveMtime, pickStaleByMtime, planRead,
} = require('../server/core/ingest-tail-core');
const {
  isDispatchWorkdir, mapAgentLine, parseTimestamp, toolTarget,
} = require('../server/core/ingest-agent-core');

const NOW = 1700000000000;

function fakeStat({ size, mtimeMs = 1000, ino = 7, birthtimeMs = 500 }) {
  return { size, mtimeMs, ino, birthtimeMs };
}

function ctx(overrides = {}) {
  return { root: '/repo', sessionId: 'sess-1', now: NOW, ...overrides };
}

// --- Tail state -----------------------------------------------------------

test('first sight of a file starts at end of file, so no history is ever replayed', () => {
  const state = createTailState(fakeStat({ size: 4096 }), { path: '/logs/a.jsonl' });
  assert.equal(state.offset, 4096);
  assert.equal(state.size, 4096);
  assert.equal(state.carry, '');
  // Nothing has changed since that sighting, so there is nothing to read.
  assert.equal(planRead(state, fakeStat({ size: 4096 })).action, 'skip');
});

test('an append reads only the bytes past the last offset', () => {
  const state = createTailState(fakeStat({ size: 10 }));
  const grown = fakeStat({ size: 26, mtimeMs: 2000 });
  const plan = planRead(state, grown);
  assert.equal(plan.action, 'read');
  assert.equal(plan.start, 10);
  assert.equal(plan.end, 26);
  assert.equal(plan.reset, false);

  const lines = applyRead(state, { text: '{"a":1}\n{"b":2}\n', end: 26, stat: grown });
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  assert.equal(state.offset, 26);
  assert.equal(state.carry, '');
});

test('a line split across two reads arrives whole exactly once', () => {
  const state = createTailState(fakeStat({ size: 0 }));
  const first = applyRead(state, { text: '{"a":1}\n{"par', end: 13, stat: fakeStat({ size: 13, mtimeMs: 2000 }) });
  assert.deepEqual(first, ['{"a":1}']);
  assert.equal(state.carry, '{"par');

  const second = applyRead(state, { text: 'tial":2}\n', end: 22, stat: fakeStat({ size: 22, mtimeMs: 3000 }) });
  assert.deepEqual(second, ['{"partial":2}']);
  assert.equal(state.carry, '');
});

/*
 * The shellHistory source asks for the empty lines a transcript read is right to drop: PSReadLine
 * writes an embedded newline as a trailing backtick, so a command ending in a newline finishes on an
 * empty physical line, and losing it glues that command to the next one (docs/plan-ingestion.md, M10).
 */
test('keepEmptyLines preserves the interior empty lines the transcript read drops', () => {
  const stat = fakeStat({ size: 20, mtimeMs: 2000 });
  const dropped = createTailState(fakeStat({ size: 0 }));
  assert.deepEqual(applyRead(dropped, { text: 'a`\n\nb\n', end: 20, stat }), ['a`', 'b']);

  const kept = createTailState(fakeStat({ size: 0 }));
  assert.deepEqual(
    applyRead(kept, { text: 'a`\n\nb\n', end: 20, stat, keepEmptyLines: true }),
    ['a`', '', 'b'],
  );
  assert.equal(kept.carry, '', 'a text ending in a break leaves no carry either way');
});

test('keepEmptyLines carries an unterminated tail exactly like the transcript read does', () => {
  const state = createTailState(fakeStat({ size: 0 }));
  const first = applyRead(state, {
    text: 'one\n\ntw', end: 7, stat: fakeStat({ size: 7, mtimeMs: 2000 }), keepEmptyLines: true,
  });
  assert.deepEqual(first, ['one', '']);
  assert.equal(state.carry, 'tw');
  const second = applyRead(state, {
    text: 'o\n', end: 9, stat: fakeStat({ size: 9, mtimeMs: 3000 }), keepEmptyLines: true,
  });
  assert.deepEqual(second, ['two']);
});

test('CRLF line endings split the same as bare newlines', () => {
  const state = createTailState(fakeStat({ size: 0 }));
  const lines = applyRead(state, {
    text: '{"a":1}\r\n{"b":2}\r\n', end: 18, stat: fakeStat({ size: 18, mtimeMs: 2000 }),
  });
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  assert.equal(state.carry, '');
});

test('a size shrink is a truncation: the offset resets and the carry goes with it', () => {
  const state = createTailState(fakeStat({ size: 100 }));
  state.carry = 'half a line from the old contents';
  const shrunk = fakeStat({ size: 20, mtimeMs: 2000 });
  const plan = planRead(state, shrunk);
  assert.equal(plan.action, 'read');
  assert.equal(plan.start, 0);
  assert.equal(plan.reset, true);

  const lines = applyRead(state, { text: '{"fresh":true}\n', end: 20, stat: shrunk, reset: true });
  assert.deepEqual(lines, ['{"fresh":true}']);
  assert.equal(state.carry, '', 'the old carry cannot prefix bytes from a truncated file');
});

test('a file recreated at the same path is a new file, not a continuation of the old one', () => {
  const state = createTailState(fakeStat({ size: 500, ino: 7, birthtimeMs: 500 }));
  state.vendorState = { pendingText: 'from the file that is gone' };
  // Same size and mtime as the old file, so only the identity says this is a different file.
  const recreated = fakeStat({ size: 500, ino: 9, birthtimeMs: 900 });
  assert.notEqual(fileIdentity(recreated), state.identity);

  const plan = planRead(state, recreated);
  assert.equal(plan.action, 'read');
  assert.equal(plan.start, 0);
  assert.equal(plan.reset, true);

  applyRead(state, { text: '{"new":1}\n', end: 500, stat: recreated, reset: true });
  assert.equal(state.vendorState, null, 'vendor state from the previous file must not carry over');
  assert.equal(state.identity, fileIdentity(recreated));
});

test('a read never spans more than the catch-up bound, and drops the line it cut into', () => {
  const state = createTailState(fakeStat({ size: 0 }));
  const grown = fakeStat({ size: 1000, mtimeMs: 2000 });
  const plan = planRead(state, grown, { maxCatchUpBytes: 100 });
  assert.equal(plan.start, 900);
  assert.equal(plan.dropPartial, true);

  const lines = applyRead(state, {
    text: 'the tail of a line whose start was skipped\n{"whole":1}\n',
    end: 1000,
    stat: grown,
    dropPartial: true,
  });
  assert.deepEqual(lines, ['{"whole":1}']);
});

test('the catch-up bound is a plan value a caller can read rather than guess', () => {
  assert.equal(MAX_CATCH_UP_BYTES, 256 * 1024);
});

test('a stat that never arrived leaves the offset exactly where it was', () => {
  const state = createTailState(fakeStat({ size: 40 }));
  const plan = planRead(state, null);
  assert.equal(plan.action, 'skip');
  assert.equal(plan.start, 40);
});

test('the tracked map is bounded, evicting the files nothing has appended to in the longest', () => {
  const states = new Map([
    ['/oldest', createTailState(fakeStat({ size: 1, mtimeMs: 100 }))],
    ['/middle', createTailState(fakeStat({ size: 1, mtimeMs: 200 }))],
    ['/newest', createTailState(fakeStat({ size: 1, mtimeMs: 300 }))],
  ]);
  assert.deepEqual(pickStaleByMtime(states, { maxTracked: 2 }), ['/oldest']);
  assert.deepEqual(pickStaleByMtime(states, { maxTracked: 5 }), []);
});

test('activeness is a window around the caller-supplied now, never a clock read here', () => {
  assert.equal(isActiveMtime(NOW - 1000, { now: NOW, withinMs: 5000 }), true);
  assert.equal(isActiveMtime(NOW - 9000, { now: NOW, withinMs: 5000 }), false);
});

// --- Claude mapping -------------------------------------------------------

function claudeLine({ text = null, tools = [], sessionId = 'claude-1', cwd = 'C:\\repo' } = {}) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const tool of tools) content.push({ type: 'tool_use', id: 'tu-1', name: tool.name, input: tool.input });
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content },
    cwd,
    sessionId,
    timestamp: '2026-08-21T17:23:50.963Z',
  });
}

test('a completed Claude assistant message becomes one agent-turn scoped to the cwd on the line itself', () => {
  const mapped = mapAgentLine({ vendor: 'claude', rawLine: claudeLine({ text: 'Reading the plan doc now.' }), ctx: ctx() });
  assert.equal(mapped.events.length, 1);
  const [event] = mapped.events;
  assert.equal(event.source, 'agentLogs');
  assert.equal(event.kind, 'agent-turn');
  assert.equal(event.summary, 'claude: Reading the plan doc now.');
  assert.deepEqual(event.scope, { root: 'C:\\repo', sessionId: 'claude-1' });
  assert.equal(event.ts, Date.parse('2026-08-21T17:23:50.963Z'));
  assert.equal(mapped.root, 'C:\\repo', 'the revised context follows the line');
});

test('each tool use in a message becomes its own agent-tool naming a bounded target', () => {
  const mapped = mapAgentLine({
    vendor: 'claude',
    rawLine: claudeLine({
      text: 'Applying both edits.',
      tools: [
        { name: 'Read', input: { file_path: 'C:\\repo\\server\\backend.js', offset: 10 } },
        { name: 'Bash', input: { command: 'npm test' } },
      ],
    }),
    ctx: ctx(),
  });
  assert.deepEqual(mapped.events.map((event) => event.kind), ['agent-turn', 'agent-tool', 'agent-tool']);
  assert.equal(mapped.events[1].summary, 'claude: Read C:\\repo\\server\\backend.js');
  assert.equal(mapped.events[2].summary, 'claude: Bash npm test');
  assert.deepEqual(mapped.events[1].detail, { vendor: 'claude', tool: 'Read' });
});

test('thinking blocks are not the turn, so a message with only thinking publishes nothing', () => {
  const rawLine = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'a long internal monologue' }] },
    sessionId: 'claude-1',
  });
  assert.deepEqual(mapAgentLine({ vendor: 'claude', rawLine, ctx: ctx() }).events, []);
});

test('a user turn, a summary line and a malformed line all publish nothing and revise nothing', () => {
  for (const rawLine of ['{"type":"user","message":{"content":"hi"}}', '{"type":"summary"}', 'not json at all', '']) {
    const mapped = mapAgentLine({ vendor: 'claude', rawLine, ctx: ctx() });
    assert.deepEqual(mapped.events, [], rawLine);
    assert.equal(mapped.root, '/repo');
    assert.equal(mapped.sessionId, 'sess-1');
  }
});

test('an unknown vendor maps to nothing rather than throwing at the shell', () => {
  assert.deepEqual(mapAgentLine({ vendor: 'gemini', rawLine: claudeLine({ text: 'hello' }), ctx: ctx() }).events, []);
});

// --- Codex mapping --------------------------------------------------------

test('a Codex session_meta line carries the cwd every later event is scoped to', () => {
  const rawLine = JSON.stringify({
    timestamp: '2026-08-21T16:32:56.173Z',
    type: 'session_meta',
    payload: { type: 'session_meta', session_id: 'codex-1', cwd: 'C:\\repo' },
  });
  const mapped = mapAgentLine({ vendor: 'codex', rawLine, ctx: ctx({ root: null, sessionId: null }) });
  assert.deepEqual(mapped.events, []);
  assert.equal(mapped.root, 'C:\\repo');
  assert.equal(mapped.sessionId, 'codex-1');
});

test('a Codex agent_message is the completed turn, and a function_call is the tool', () => {
  const turn = mapAgentLine({
    vendor: 'codex',
    rawLine: JSON.stringify({
      timestamp: '2026-08-21T16:33:04.792Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'I will read the ingestion plan end to end.' },
    }),
    ctx: ctx({ sessionId: 'codex-1' }),
  });
  assert.equal(turn.events[0].kind, 'agent-turn');
  assert.equal(turn.events[0].summary, 'codex: I will read the ingestion plan end to end.');

  const tool = mapAgentLine({
    vendor: 'codex',
    rawLine: JSON.stringify({
      timestamp: '2026-08-21T16:33:04.801Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"npm test","timeout_ms":10000}' },
    }),
    ctx: ctx({ sessionId: 'codex-1' }),
  });
  assert.equal(tool.events[0].kind, 'agent-tool');
  assert.equal(tool.events[0].summary, 'codex: shell_command npm test');
});

test('a Codex response_item/message is skipped, because it is the raw request item, not the turn', () => {
  const rawLine = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'the whole system prompt' }] },
  });
  assert.deepEqual(mapAgentLine({ vendor: 'codex', rawLine, ctx: ctx() }).events, []);
});

// --- Grok mapping ---------------------------------------------------------

function grokLine(update, sessionId = 'grok-1') {
  return JSON.stringify({ timestamp: 1786136976, method: '_x.ai/session/update', params: { sessionId, update } });
}

test('Grok message chunks accumulate and only the completed turn publishes', () => {
  let vendorState = null;
  const first = mapAgentLine({
    vendor: 'grok',
    rawLine: grokLine({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will pull' } }),
    ctx: ctx(),
    vendorState,
  });
  assert.deepEqual(first.events, [], 'a chunk is streaming, never an event');
  vendorState = first.vendorState;

  const second = mapAgentLine({
    vendor: 'grok',
    rawLine: grokLine({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'current facts.' } }),
    ctx: ctx(),
    vendorState,
  });
  vendorState = second.vendorState;

  const done = mapAgentLine({
    vendor: 'grok',
    rawLine: grokLine({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }),
    ctx: ctx(),
    vendorState,
  });
  assert.equal(done.events.length, 1);
  assert.equal(done.events[0].kind, 'agent-turn');
  assert.equal(done.events[0].summary, 'grok: I will pull current facts.');
  assert.equal(done.vendorState, null, 'the held text is spent, not carried into the next turn');
});

test('a Grok tool_call publishes once and its streaming updates publish nothing', () => {
  const call = mapAgentLine({
    vendor: 'grok',
    rawLine: grokLine({
      sessionUpdate: 'tool_call',
      title: 'web_fetch',
      rawInput: { url: 'https://api.scryfall.com/bulk-data' },
      _meta: { 'x.ai/tool': { name: 'web_fetch' } },
    }),
    ctx: ctx({ root: '/repo' }),
  });
  assert.equal(call.events[0].summary, 'grok: web_fetch https://api.scryfall.com/bulk-data');
  assert.equal(call.events[0].scope.sessionId, 'grok-1');

  const update = mapAgentLine({
    vendor: 'grok',
    rawLine: grokLine({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', kind: 'fetch' }),
    ctx: ctx(),
  });
  assert.deepEqual(update.events, []);
});

test('an aborted Grok turn does not surface as the NEXT turn summary', () => {
  const chunk = (text) => grokLine({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  let vendorState = mapAgentLine({ vendor: 'grok', rawLine: chunk('half of an abandoned answer'), ctx: ctx() }).vendorState;

  // The turn never completes: the run was aborted, and the carbon unit types a fresh prompt.
  const boundary = mapAgentLine({
    vendor: 'grok',
    rawLine: grokLine({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'a new question' } }),
    ctx: ctx(),
    vendorState,
  });
  assert.equal(boundary.vendorState, null, 'a fresh prompt is a turn boundary');
  vendorState = boundary.vendorState;

  vendorState = mapAgentLine({ vendor: 'grok', rawLine: chunk('the real answer'), ctx: ctx(), vendorState }).vendorState;
  const done = mapAgentLine({
    vendor: 'grok',
    rawLine: grokLine({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }),
    ctx: ctx(),
    vendorState,
  });
  assert.equal(done.events[0].summary, 'grok: the real answer');
});

test('a Grok retry is also a turn boundary, since the retried turn resends its text', () => {
  let vendorState = mapAgentLine({
    vendor: 'grok',
    rawLine: grokLine({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first attempt' } }),
    ctx: ctx(),
  }).vendorState;
  vendorState = mapAgentLine({
    vendor: 'grok',
    rawLine: grokLine({ sessionUpdate: 'retry_state', type: 'retrying', attempt: 1 }),
    ctx: ctx(),
    vendorState,
  }).vendorState;
  assert.equal(vendorState, null);
});

test('a Grok turn that completed with nothing held still says the turn ended', () => {
  const done = mapAgentLine({
    vendor: 'grok',
    rawLine: grokLine({ sessionUpdate: 'turn_completed', stop_reason: 'rate_limit' }),
    ctx: ctx(),
  });
  assert.equal(done.events[0].summary, 'grok: turn complete (rate_limit)');
});

// --- The workdir shape rule -----------------------------------------------

test('a dispatch workdir is recognized as a raw cwd, an encoded dir name, and a percent-encoded one', () => {
  const workDir = 'C:\\Users\\johnw\\AppData\\Local\\Temp\\glissa-navigator-AbC123';
  assert.equal(isDispatchWorkdir(workDir), true, 'the raw cwd a line carries');
  assert.equal(
    isDispatchWorkdir('C--Users-johnw-AppData-Local-Temp-glissa-navigator-AbC123'),
    true,
    'the Claude project directory name, every separator collapsed to one dash',
  );
  assert.equal(isDispatchWorkdir(encodeURIComponent(workDir)), true, 'the Grok session directory name');
});

test('the shape rule is a segment match, so ordinary glissa paths are untouched', () => {
  for (const candidate of [
    'C:\\Users\\johnw\\Projects\\glissa',
    'C--Users-johnw-Projects-glissa',
    'C--Users-johnw-Projects--glissa-worktrees-glissa-nC0h6B',
    '/home/dev/glissa-navigator',
    'glissanavigator-x',
    null,
    '',
  ]) {
    assert.equal(isDispatchWorkdir(candidate), false, String(candidate));
  }
});

// --- Shared helpers -------------------------------------------------------

test('timestamps arrive as ISO strings from two vendors and whole seconds from the third', () => {
  assert.equal(parseTimestamp('2026-08-21T17:23:50.963Z'), Date.parse('2026-08-21T17:23:50.963Z'));
  assert.equal(parseTimestamp(1786136976), 1786136976000);
  assert.equal(parseTimestamp(1786136976000), 1786136976000);
  assert.equal(parseTimestamp('not a date'), null);
  assert.equal(parseTimestamp(null), null);
});

test('a tool target is the first meaningful input field, folded to one bounded line', () => {
  assert.equal(toolTarget({ file_path: 'a.js', command: 'rm -rf' }), 'a.js');
  assert.equal(toolTarget({ command: 'npm run\n  build' }), 'npm run build');
  assert.equal(toolTarget({ command: 'x'.repeat(500) }).length, 120);
  assert.equal(toolTarget({ unknown_field: 'value' }), '');
  assert.equal(toolTarget(null), '');
});
