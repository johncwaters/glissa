import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { TraceRecord } from '../shared/contracts/trace.ts';
import { TOOL_DETAIL_MAX_CHARS } from '../shared/tool-detail.ts';

const importCore = () => import('../public/trace-view-core.ts');

const baseRecord = {
  ts: 1,
  uuid: null,
  parentUuid: null,
  vendorSessionId: 'vendor-session',
};

function record(value: Record<string, unknown>): TraceRecord {
  return TraceRecord.parse({ ...baseRecord, ...value });
}

async function turnsOf(records: readonly TraceRecord[]) {
  const { appendTraceRecords, createTraceGrouping } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, records);
  return grouping.turns;
}

test('ordered records group into prompt-headed turns without reversing them', async () => {
  const records = [
    record({ kind: 'thinking', text: 'before any prompt' }),
    record({ kind: 'prompt', text: 'first prompt' }),
    record({ kind: 'assistant', text: 'first answer' }),
    record({ kind: 'prompt', text: 'second prompt' }),
    record({ kind: 'assistant', text: 'second answer' }),
  ];
  const turns = await turnsOf(records);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].head, null);
  assert.equal(turns[0].rows[0].record.kind, 'thinking');
  assert.equal(turns[1].head?.text, 'first prompt');
  assert.equal(turns[2].head?.text, 'second prompt');
  assert.equal(turns[2].rows[0].text, 'second answer');
});

test('a session boundary and a typed command each head a turn of their own', async () => {
  const records = [
    record({ kind: 'session', vendor: 'claude', transcriptPath: '/trace.jsonl' }),
    record({ kind: 'prompt', text: 'first prompt' }),
    record({ kind: 'assistant', text: 'first answer' }),
    record({ kind: 'expansion', text: '<command-name>/review</command-name>\ncommand body' }),
    record({ kind: 'assistant', text: 'review answer' }),
    record({ kind: 'session', vendor: 'claude', transcriptPath: '/trace.jsonl', reason: 'resumed' }),
  ];
  const turns = await turnsOf(records);
  assert.deepEqual(turns.map((turn) => [turn.head?.tag ?? null, turn.head?.text ?? null]), [
    ['SESSION', 'claude vendor-session'],
    ['PROMPT', 'first prompt'],
    ['EXPANSION', '/review'],
    ['SESSION', 'claude vendor-session'],
  ]);
  assert.deepEqual(turns[2].rows.map((row) => [row.tag, row.text]), [['ASSISTANT', 'review answer']]);
});

test('a skill expansion stays inside its turn because it carries a tool use id', async () => {
  const records = [
    record({ kind: 'prompt', text: 'run the skill' }),
    record({ kind: 'tool_call', toolUseId: 'skill-1', name: 'Skill', input: { skill: 'release' } }),
    record({ kind: 'expansion', toolUseId: 'skill-1', text: 'skill body' }),
    record({ kind: 'expansion', text: 'injected context' }),
  ];
  const turns = await turnsOf(records);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].rows.map((row) => [row.tag, row.text]), [
    ['TOOL', 'Skill: release'],
    ['EXPANSION', 'release'],
    ['EXPANSION', 'context'],
  ]);
});

test('a later page appends to the open turn and starts new ones without regrouping', async () => {
  const { appendTraceRecords, createTraceGrouping } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'prompt', text: 'first prompt' }),
    record({ kind: 'tool_call', toolUseId: 'bash-1', name: 'Bash', input: { command: 'npm test' } }),
  ]);
  const firstTurn = grouping.turns[0];

  const appends = appendTraceRecords(grouping, [
    record({ kind: 'tool_result', toolUseId: 'bash-1', content: 'ok', isError: false, truncated: false }),
    record({ kind: 'prompt', text: 'second prompt' }),
    record({ kind: 'assistant', text: 'second answer' }),
  ]);

  assert.equal(grouping.turns[0], firstTurn);
  assert.equal(grouping.turns.length, 2);
  assert.deepEqual(appends.map((append) => ({ turnIndex: append.turnIndex, isNewTurn: append.isNewTurn, rows: append.rows.length })), [
    { turnIndex: 0, isNewTurn: false, rows: 1 },
    { turnIndex: 1, isNewTurn: true, rows: 1 },
  ]);
  assert.equal(appends.some((append) => Object.hasOwn(append, 'startedAt')), false);
  assert.equal(appends[1].head?.text, 'second prompt');
  assert.equal(appends[0].rows[0].text, 'Bash result: 2 bytes');
  assert.equal(grouping.turns[0].rows.length, 2);
});

test('tool rows share detail fields, resolve results to calls and carry markers', async () => {
  const { traceRecordBody } = await importCore();
  const command = `${'x'.repeat(TOOL_DETAIL_MAX_CHARS + 20)}\nsecond line`;
  const records = [
    record({ kind: 'prompt', text: 'run it' }),
    record({ kind: 'tool_call', toolUseId: 'bash-1', name: 'Bash', input: { command } }),
    record({ kind: 'tool_result', toolUseId: 'bash-1', content: 'ok', isError: true, truncated: true }),
  ];
  const rows = (await turnsOf(records))[0].rows;
  assert.equal(rows[0].text.startsWith('Bash: '), true);
  assert.equal(rows[0].text.endsWith('...'), true);
  assert.equal(rows[0].text.includes('second line'), false);
  assert.equal(rows[1].text, 'Bash result: 2 bytes');
  assert.deepEqual(rows[1].badges, ['error', 'truncated', '0ms']);
  assert.equal(traceRecordBody(rows[0].record), JSON.stringify({ command }, null, 2));
});

test('thinking, assistant, notice and subagent rows carry concise text', async () => {
  const records = [
    record({ kind: 'thinking', text: 'reasoning\nmore' }),
    record({ kind: 'assistant', text: 'answer\nmore', agentType: 'general-purpose' }),
    record({ kind: 'notice', text: 'skipped bytes' }),
  ];
  const rows = (await turnsOf(records))[0].rows;
  assert.deepEqual(rows.map((row) => [row.tag, row.text]), [
    ['THINKING', 'reasoning'],
    ['ASSISTANT', '[general-purpose] answer'],
    ['NOTICE', 'skipped bytes'],
  ]);
  assert.equal(rows[2].tone, 'muted');
});

test('concurrent subagents of one type carry distinct id suffixes', async () => {
  const records = [
    record({ kind: 'assistant', text: 'first answer', agentId: 'agent-4f2c1a', agentType: 'general-purpose' }),
    record({ kind: 'assistant', text: 'second answer', agentId: 'agent-9d8e7b', agentType: 'general-purpose' }),
  ];
  const rows = (await turnsOf(records))[0].rows;
  assert.equal(rows[0].text, '[general-purpose 4f2c1a] first answer');
  assert.equal(rows[1].text, '[general-purpose 9d8e7b] second answer');
});

test('a truncated prompt row carries a truncation badge', async () => {
  const rows = (await turnsOf([record({ kind: 'prompt', text: 'prompt', truncated: true })]))[0].head;
  assert.equal(rows?.text, 'prompt');
  assert.deepEqual(rows?.badges, ['truncated']);
});

test('a truncated tool call row keeps its detail field and carries a badge', async () => {
  const records = [
    record({ kind: 'prompt', text: 'write it' }),
    record({
      kind: 'tool_call',
      toolUseId: 'write-1',
      name: 'Write',
      input: { file_path: '/repo/src/big.ts', content: 'c'.repeat(64) },
      truncated: true,
    }),
  ];
  const rows = (await turnsOf(records))[0].rows;
  assert.equal(rows[0].text, 'Write: /repo/src/big.ts');
  assert.deepEqual(rows[0].badges, ['truncated']);
});

test('a truncated raw row keeps its text and carries a badge', async () => {
  const rows = (await turnsOf([record({ kind: 'raw', line: 'not json', truncated: true })]))[0].rows;
  assert.deepEqual([rows[0].tag, rows[0].text], ['RAW', 'not json']);
  assert.deepEqual(rows[0].badges, ['truncated']);
});

test('trace row parts name every kind and derive error and muted tones', async () => {
  const { traceRowParts } = await importCore();
  const toolCall = record({ kind: 'tool_call', toolUseId: 'bash-1', name: 'Bash', input: { command: 'npm test' } });
  if (toolCall.kind !== 'tool_call') assert.fail('expected a tool call');
  const toolCalls = new Map([['bash-1', toolCall]]);
  const records = [
    record({ kind: 'prompt', text: 'prompt' }),
    record({ kind: 'thinking', text: 'thinking' }),
    record({ kind: 'assistant', text: 'answer' }),
    toolCall,
    record({ kind: 'tool_result', toolUseId: 'bash-1', content: 'ok', isError: false, truncated: false }),
    record({ kind: 'session', vendor: 'claude', transcriptPath: '/trace.jsonl' }),
    record({ kind: 'notice', text: 'notice' }),
    record({ kind: 'raw', line: 'raw' }),
    record({ kind: 'expansion', text: 'context' }),
  ];

  assert.deepEqual(records.map((traceRecord) => traceRowParts(traceRecord, toolCalls).tag), [
    'PROMPT',
    'THINKING',
    'ASSISTANT',
    'TOOL',
    'RESULT',
    'SESSION',
    'NOTICE',
    'RAW',
    'EXPANSION',
  ]);
  assert.equal(traceRowParts(records[0], toolCalls).text, 'prompt');
  assert.equal(traceRowParts(records[6], toolCalls).tone, 'muted');
  const failedResult = record({ kind: 'tool_result', toolUseId: 'bash-1', content: 'no', isError: true, truncated: false });
  assert.deepEqual(traceRowParts(failedResult, toolCalls), {
    kind: 'tool_result',
    tag: 'RESULT',
    text: 'Bash result: 2 bytes',
    tone: 'error',
    badges: ['error', '0ms'],
  });
});

test('selector rules honor a valid preselection, preserve selection and fall back only once the panel is shown', async () => {
  const { resolveTraceSessionId, traceSessionOptions } = await importCore();
  const options = traceSessionOptions([
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
    { id: 'a', name: 'Duplicate' },
  ]);
  assert.deepEqual(options, [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }]);
  assert.equal(resolveTraceSessionId(options, 'b', 'a'), 'b');
  assert.equal(resolveTraceSessionId(options, 'missing', 'b'), 'b');
  assert.equal(resolveTraceSessionId(options, null, 'missing'), 'a');
  assert.equal(resolveTraceSessionId([], 'a', 'a'), null);
  assert.equal(resolveTraceSessionId(options, null, null, false), null);
  assert.equal(resolveTraceSessionId(options, 'b', null, false), 'b');
});

test('a page is requested only for a selected session on a visible panel with nothing in flight', async () => {
  const { nextTraceRequest } = await importCore();
  const visible = { selectedSessionId: 'a', isPanelVisible: true, hasPendingRequest: false, hasLoadedOnce: true, nextOffset: 512 };
  assert.deepEqual(nextTraceRequest(visible), { id: 'a', direction: 'forward', after: 512 });
  assert.equal(nextTraceRequest({ ...visible, isPanelVisible: false }), null);
  assert.equal(nextTraceRequest({ ...visible, hasPendingRequest: true }), null);
  assert.equal(nextTraceRequest({ ...visible, selectedSessionId: null }), null);
});

test('empty state names the selected session and handles an empty selector', async () => {
  const { traceEmptyState } = await importCore();
  assert.equal(traceEmptyState({ id: 'a', label: 'Alpha' }), 'No trace has been recorded for Alpha.');
  assert.equal(traceEmptyState(null), 'No sessions are available.');
});

test('the first request for a session asks for the tail and later requests walk forward', async () => {
  const { nextTraceRequest } = await importCore();
  const unseeded = { selectedSessionId: 'a', isPanelVisible: true, hasPendingRequest: false, hasLoadedOnce: false, nextOffset: 0 };
  assert.deepEqual(nextTraceRequest(unseeded), { id: 'a', direction: 'tail', after: 0, endingAt: 'tail' });
  assert.deepEqual(nextTraceRequest({ ...unseeded, hasLoadedOnce: true, nextOffset: 900 }), { id: 'a', direction: 'forward', after: 900 });
  assert.equal(nextTraceRequest({ ...unseeded, hasPendingRequest: true }), null);
});

test('an earlier page is offered only while a contiguous start is known', async () => {
  const { earlierTraceRequest, hasEarlierTracePages } = await importCore();
  const seeded = {
    selectedSessionId: 'a',
    hasPendingRequest: false,
    hasLoadedOnce: true,
    hasDroppedEarliestRows: false,
    firstOffset: 4096,
    residentRowCount: 4999,
  };
  assert.equal(hasEarlierTracePages(seeded), true);
  assert.deepEqual(earlierTraceRequest(seeded), { id: 'a', direction: 'earlier', after: 0, endingAt: 4096 });
  assert.equal(hasEarlierTracePages({ ...seeded, firstOffset: 0 }), false);
  assert.equal(hasEarlierTracePages({ ...seeded, hasLoadedOnce: false }), false);
  assert.equal(hasEarlierTracePages({ ...seeded, hasDroppedEarliestRows: true }), false);
  assert.equal(hasEarlierTracePages({ ...seeded, residentRowCount: 5000 }), false);
  assert.equal(earlierTraceRequest({ ...seeded, hasPendingRequest: true }), null);
  assert.equal(earlierTraceRequest({ ...seeded, residentRowCount: 5000 }), null);
});

test('a reply is applied forward, applied earlier, reset or dropped by the pending request it answers', async () => {
  const { traceReplyOutcome } = await importCore();
  const resident = { sessionId: 'a', firstOffset: 4096, nextOffset: 9000, hasLoadedOnce: true };
  const forward = { id: 'a', direction: 'forward' as const, after: 9000 };
  const earlier = { id: 'a', direction: 'earlier' as const, after: 0, endingAt: 4096 };
  const tail = { id: 'a', direction: 'tail' as const, after: 0, endingAt: 'tail' as const };
  const reply = { id: 'a', start: 9000, next: 9500, reset: false };
  const earlierReply = { id: 'a', start: 3500, next: 4096, reset: false };
  const tailReply = { id: 'a', start: 8500, next: 9000, reset: false };

  assert.equal(traceReplyOutcome({ pendingRequest: forward, resident, reply }), 'append');
  assert.equal(traceReplyOutcome({ pendingRequest: earlier, resident, reply: earlierReply }), 'prepend');
  assert.equal(traceReplyOutcome({ pendingRequest: tail, resident: { ...resident, hasLoadedOnce: false }, reply: tailReply }), 'seed');
  assert.equal(traceReplyOutcome({ pendingRequest: forward, resident, reply: { ...reply, reset: true } }), 'reset');
  assert.equal(traceReplyOutcome({ pendingRequest: null, resident, reply }), 'ignore');
  assert.equal(traceReplyOutcome({ pendingRequest: forward, resident, reply: { ...reply, id: 'b' } }), 'ignore');
  assert.equal(traceReplyOutcome({ pendingRequest: forward, resident: { ...resident, nextOffset: 12 }, reply }), 'stale');
  assert.equal(traceReplyOutcome({ pendingRequest: earlier, resident: { ...resident, firstOffset: 12 }, reply: earlierReply }), 'stale');
  assert.equal(traceReplyOutcome({ pendingRequest: tail, resident, reply: tailReply }), 'stale');
  assert.equal(traceReplyOutcome({ pendingRequest: forward, resident: null, reply }), 'stale');
  assert.equal(traceReplyOutcome({ pendingRequest: forward, resident, reply: { ...reply, start: 8999 } }), 'reset');
  assert.equal(traceReplyOutcome({ pendingRequest: earlier, resident, reply: { ...earlierReply, next: 4095 } }), 'reset');
  assert.equal(traceReplyOutcome({ pendingRequest: forward, resident, reply: { ...reply, next: 8999 } }), 'reset');
});

test('an earlier page prepends its turns and merges the turn split across the page boundary', async () => {
  const { appendTraceRecords, createTraceGrouping, prependTraceRecords } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'assistant', text: 'tail of the earlier turn' }),
    record({ kind: 'prompt', text: 'resident prompt' }),
  ]);
  prependTraceRecords(grouping, [
    record({ kind: 'prompt', text: 'earlier prompt' }),
    record({ kind: 'tool_call', toolUseId: 'bash-1', name: 'Bash', input: { command: 'npm test' } }),
  ]);

  assert.deepEqual(grouping.turns.map((turn) => turn.head?.text ?? null), ['earlier prompt', 'resident prompt']);
  assert.deepEqual(grouping.turns[0].rows.map((row) => row.text), ['Bash: npm test', 'tail of the earlier turn']);
  assert.equal(grouping.toolCallByUseId.has('bash-1'), true);
});

test('prepending preserves resident turn objects and reports only newly built turns', async () => {
  const { appendTraceRecords, createTraceGrouping, prependTraceRecords } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'prompt', text: 'resident prompt' }),
    record({ kind: 'assistant', text: 'resident answer' }),
  ]);
  const residentTurn = grouping.turns[0];
  const prepend = prependTraceRecords(grouping, [
    record({ kind: 'prompt', text: 'earlier prompt' }),
    record({ kind: 'assistant', text: 'earlier answer' }),
  ]);

  assert.equal(prepend.newTurns.length, 1);
  assert.equal(grouping.turns[1], residentTurn);
});

test('a boundary turn split lowers the resident base and still merges in place', async () => {
  const { appendTraceRecords, createTraceGrouping, prependTraceRecords } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [record({ kind: 'assistant', text: 'resident answer', ts: 5000 })]);

  const prepend = prependTraceRecords(grouping, [record({ kind: 'prompt', text: 'earlier prompt', ts: 1000 })]);

  assert.equal(grouping.turns[0].startedAt, 1000);
  assert.equal(prepend.mergedHead?.text, 'earlier prompt');
  assert.equal(prepend.needsRerender, false);
});

test('turn durations measure from the turn start to its latest row', async () => {
  const { appendTraceRecords, createTraceGrouping, traceTurnDurationMs } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'prompt', text: 'prompt', ts: 1000 }),
    record({ kind: 'assistant', text: 'answer', ts: 2500 }),
    record({ kind: 'thinking', text: 'late', ts: 6000 }),
  ]);
  assert.equal(grouping.turns[0].startedAt, 1000);
  assert.equal(traceTurnDurationMs(grouping.turns[0]), 5000);
});

test('turn metrics format counts bytes and elapsed time', async () => {
  const { appendTraceRecords, createTraceGrouping, formatTurnMetrics } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'prompt', text: 'prompt', ts: 1000 }),
    ...Array.from({ length: 5 }, (_, toolNumber) => record({
      kind: 'tool_call',
      toolUseId: `tool-${toolNumber}`,
      name: 'Bash',
      input: {},
      ts: 2000 + toolNumber,
    })),
    record({ kind: 'tool_result', toolUseId: 'tool-0', content: 'x'.repeat(12698), isError: true, truncated: false, ts: 3000 }),
    ...Array.from({ length: 7 }, (_, rowNumber) => record({
      kind: 'assistant',
      text: `answer ${rowNumber}`,
      ts: rowNumber === 6 ? 93000 : 4000 + rowNumber,
    })),
  ]);
  assert.equal(formatTurnMetrics(grouping.turns[0]), '14 rows, 5 tools, 1 error, 12.4 KB, 1:32');
});

test('turn metrics accumulate through append and prepend merge and reduce on trim', async () => {
  const { appendTraceRecords, createTraceGrouping, prependTraceRecords, trimTraceGrouping } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'assistant', text: 'resident answer', ts: 3000 }),
    record({ kind: 'tool_result', toolUseId: 'bash-1', content: 'okay', isError: true, truncated: false, ts: 4000 }),
  ]);
  assert.deepEqual(grouping.turns[0].metrics, { rowCount: 2, toolCallCount: 0, errorCount: 1, resultBytes: 4 });

  prependTraceRecords(grouping, [
    record({ kind: 'prompt', text: 'earlier prompt', ts: 1000 }),
    record({ kind: 'tool_call', toolUseId: 'bash-1', name: 'Bash', input: {}, ts: 2000 }),
  ]);
  assert.deepEqual(grouping.turns[0].metrics, { rowCount: 4, toolCallCount: 1, errorCount: 1, resultBytes: 4 });

  assert.deepEqual(trimTraceGrouping(grouping, 2), { droppedTurnCount: 0, droppedRowCount: 2 });
  assert.deepEqual(grouping.turns[0].metrics, { rowCount: 2, toolCallCount: 0, errorCount: 1, resultBytes: 4 });
});

test('a page beginning with a tool result is relabeled when its Bash call arrives earlier', async () => {
  const { appendTraceRecords, createTraceGrouping, prependTraceRecords } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'tool_result', toolUseId: 'bash-1', content: 'ok', isError: false, truncated: false, ts: 1142 }),
  ]);

  assert.equal(grouping.turns[0].rows[0].text, 'Tool result: 2 bytes');
  assert.deepEqual(grouping.turns[0].rows[0].badges, []);
  const prepend = prependTraceRecords(grouping, [
    record({ kind: 'tool_call', toolUseId: 'bash-1', name: 'Bash', input: { command: 'npm test' }, ts: 1000 }),
  ]);
  assert.equal(prepend.needsRerender, true);
  assert.equal(grouping.turns[0].rows[1].text, 'Bash result: 2 bytes');
  assert.deepEqual(grouping.turns[0].rows[1].badges, ['142ms']);
  assert.equal(grouping.unresolvedToolUseCounts.size, 0);
});

test('tool latency uses seconds above one second and ignores negative deltas', async () => {
  const { traceRowParts } = await importCore();
  const toolCall = record({ kind: 'tool_call', toolUseId: 'bash-1', name: 'Bash', input: {}, ts: 1000 });
  if (toolCall.kind !== 'tool_call') assert.fail('expected a tool call');
  const toolCalls = new Map([['bash-1', toolCall]]);
  const slowResult = record({ kind: 'tool_result', toolUseId: 'bash-1', content: 'ok', isError: false, truncated: false, ts: 2249 });
  const earlyResult = record({ kind: 'tool_result', toolUseId: 'bash-1', content: 'ok', isError: false, truncated: false, ts: 999 });
  assert.deepEqual(traceRowParts(slowResult, toolCalls).badges, ['1.2s']);
  assert.deepEqual(traceRowParts(earlyResult, toolCalls).badges, []);
});

test('a tool result stays relabelable when its call arrives two pages later', async () => {
  const { appendTraceRecords, createTraceGrouping, prependTraceRecords } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [record({ kind: 'assistant', text: 'resident answer' })]);

  const firstPrepend = prependTraceRecords(grouping, [
    record({ kind: 'tool_result', toolUseId: 'bash-1', content: 'ok', isError: false, truncated: false }),
  ]);
  assert.equal(firstPrepend.needsRerender, false);
  assert.equal(grouping.unresolvedToolUseCounts.has('bash-1'), true);

  const secondPrepend = prependTraceRecords(grouping, [
    record({ kind: 'tool_call', toolUseId: 'bash-1', name: 'Bash', input: { command: 'npm test' } }),
  ]);
  assert.equal(secondPrepend.needsRerender, true);
  assert.deepEqual(grouping.turns[0].rows.map((row) => row.text), [
    'Bash: npm test',
    'Bash result: 2 bytes',
    'resident answer',
  ]);
});

test('prepending a page without an unresolved call does not need a rerender', async () => {
  const { appendTraceRecords, createTraceGrouping, prependTraceRecords } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'tool_result', toolUseId: 'bash-1', content: 'ok', isError: false, truncated: false }),
  ]);

  const prepend = prependTraceRecords(grouping, [
    record({ kind: 'tool_call', toolUseId: 'write-1', name: 'Write', input: { file_path: '/repo/file.ts', content: 'ok' } }),
  ]);
  assert.equal(prepend.needsRerender, false);
});

test('an expansion is relabeled when its call arrives on an earlier page', async () => {
  const { appendTraceRecords, createTraceGrouping, prependTraceRecords } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'expansion', toolUseId: 'bash-1', text: 'expanded command' }),
  ]);

  assert.deepEqual([grouping.turns[0].rows[0].tag, grouping.turns[0].rows[0].text], ['EXPANSION', 'expansion']);
  const prepend = prependTraceRecords(grouping, [
    record({ kind: 'tool_call', toolUseId: 'bash-1', name: 'Bash', input: { command: 'npm test' } }),
  ]);
  assert.equal(prepend.needsRerender, true);
  assert.deepEqual([grouping.turns[0].rows[1].tag, grouping.turns[0].rows[1].text], ['EXPANSION', 'npm test']);
});

test('the resident window drops its oldest turns once the row ceiling is passed', async () => {
  const { appendTraceRecords, createTraceGrouping, trimTraceGrouping } = await importCore();
  const grouping = createTraceGrouping();
  for (let turnNumber = 0; turnNumber < 4; turnNumber += 1) {
    appendTraceRecords(grouping, [
      record({ kind: 'prompt', text: `prompt ${turnNumber}` }),
      record({ kind: 'tool_call', toolUseId: `bash-${turnNumber}`, name: 'Bash', input: { command: 'npm test' } }),
      record({ kind: 'assistant', text: `answer ${turnNumber}` }),
    ]);
  }

  assert.deepEqual(trimTraceGrouping(grouping, 12), { droppedTurnCount: 0, droppedRowCount: 0 });
  assert.deepEqual(trimTraceGrouping(grouping, 7), { droppedTurnCount: 2, droppedRowCount: 0 });
  assert.deepEqual(grouping.turns.map((turn) => turn.head?.text ?? null), ['prompt 2', 'prompt 3']);
  assert.equal(grouping.toolCallByUseId.has('bash-0'), false);
  assert.equal(grouping.toolCallByUseId.has('bash-3'), true);
  assert.deepEqual(trimTraceGrouping(grouping, 1), { droppedTurnCount: 1, droppedRowCount: 2 });
  assert.equal(grouping.turns.length, 1);
  assert.equal(grouping.turns[0].head?.text, 'prompt 3');
  assert.equal(grouping.turns[0].rows.length, 0);
  assert.equal(grouping.turns[0].hasTrimmedRows, true);
});

test('trimming forgets the pending ids of dropped turns and dropped rows', async () => {
  const { appendTraceRecords, createTraceGrouping, trimTraceGrouping } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'prompt', text: 'first prompt' }),
    record({ kind: 'tool_result', toolUseId: 'bash-1', content: 'ok', isError: false, truncated: false }),
    record({ kind: 'prompt', text: 'second prompt' }),
    record({ kind: 'tool_result', toolUseId: 'bash-2', content: 'ok', isError: false, truncated: false }),
    record({ kind: 'assistant', text: 'second answer' }),
  ]);
  assert.deepEqual([...grouping.unresolvedToolUseCounts.keys()], ['bash-1', 'bash-2']);

  assert.deepEqual(trimTraceGrouping(grouping, 3), { droppedTurnCount: 1, droppedRowCount: 0 });
  assert.equal(grouping.unresolvedToolUseCounts.has('bash-1'), false);
  assert.deepEqual(trimTraceGrouping(grouping, 1), { droppedTurnCount: 0, droppedRowCount: 2 });
  assert.equal(grouping.unresolvedToolUseCounts.size, 0);
});

test('a surviving row keeps its pending id when a second row referencing it is trimmed', async () => {
  const { appendTraceRecords, createTraceGrouping, prependTraceRecords, trimTraceGrouping } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'prompt', text: 'run the skill' }),
    record({ kind: 'expansion', toolUseId: 'skill-1', text: 'expanded skill' }),
    record({ kind: 'tool_result', toolUseId: 'skill-1', content: 'ok', isError: false, truncated: false }),
    record({ kind: 'assistant', text: 'skill answer' }),
  ]);
  assert.equal(grouping.unresolvedToolUseCounts.get('skill-1'), 2);

  assert.deepEqual(trimTraceGrouping(grouping, 3), { droppedTurnCount: 0, droppedRowCount: 1 });
  assert.equal(grouping.unresolvedToolUseCounts.get('skill-1'), 1);

  const prepend = prependTraceRecords(grouping, [
    record({ kind: 'tool_call', toolUseId: 'skill-1', name: 'Skill', input: { skill: 'code-review' } }),
  ]);
  assert.equal(prepend.needsRerender, true);
  assert.equal(grouping.unresolvedToolUseCounts.size, 0);
  assert.deepEqual(grouping.turns[0].rows.map((row) => row.text), ['Skill: code-review']);
  assert.deepEqual(grouping.turns[1].rows.map((row) => row.text), [
    'Skill result: 2 bytes',
    'skill answer',
  ]);
});

test('a single oversized turn keeps its heading and newest rows within the ceiling', async () => {
  const { appendTraceRecords, createTraceGrouping, traceResidentRowCount, trimTraceGrouping } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'prompt', text: 'long turn' }),
    ...Array.from({ length: 8 }, (_, rowNumber) => record({ kind: 'assistant', text: `answer ${rowNumber}` })),
  ]);

  assert.deepEqual(trimTraceGrouping(grouping, 5), { droppedTurnCount: 0, droppedRowCount: 4 });
  assert.equal(grouping.turns[0].head?.text, 'long turn');
  assert.deepEqual(grouping.turns[0].rows.map((row) => row.text), [
    'answer 4',
    'answer 5',
    'answer 6',
    'answer 7',
  ]);
  assert.equal(grouping.turns[0].hasTrimmedRows, true);
  assert.equal(traceResidentRowCount(grouping), 5);
});

test('the view rebuilds only for a changed selection or a stale render', async () => {
  const { shouldRebuildTraceView } = await importCore();
  const settled = { hasSelectionChanged: false, isRenderedTraceStale: false, hasRenderedOnce: true };
  assert.equal(shouldRebuildTraceView(settled), false);
  assert.equal(shouldRebuildTraceView({ ...settled, hasSelectionChanged: true }), true);
  assert.equal(shouldRebuildTraceView({ ...settled, isRenderedTraceStale: true }), true);
  assert.equal(shouldRebuildTraceView({ ...settled, hasRenderedOnce: false }), true);
});

test('trace kind filters toggle without mutating their input', async () => {
  const { isKindHidden, toggleHiddenKind } = await importCore();
  const hiddenKinds = ['thinking'];
  const kindsWithToolResults = toggleHiddenKind(hiddenKinds, 'tool_result');
  assert.deepEqual(hiddenKinds, ['thinking']);
  assert.deepEqual(kindsWithToolResults, ['thinking', 'tool_result']);
  assert.equal(isKindHidden(kindsWithToolResults, 'tool_result'), true);
  assert.deepEqual(toggleHiddenKind(kindsWithToolResults, 'thinking'), ['tool_result']);
  assert.equal(isKindHidden([], 'raw'), false);
});

test('a session start reads only from a resident window that still holds the first row', async () => {
  const { appendTraceRecords, createTraceGrouping, traceSessionStartedAtMs } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [record({ kind: 'prompt', text: 'first prompt', ts: 1000 })]);
  const firstTurn = grouping.turns[0];

  assert.equal(traceSessionStartedAtMs(0, false, firstTurn), 1000);
  assert.equal(traceSessionStartedAtMs(4096, false, firstTurn), null);
  assert.equal(traceSessionStartedAtMs(0, true, firstTurn), null);
  assert.equal(traceSessionStartedAtMs(0, false, undefined), null);
  assert.equal(traceSessionStartedAtMs(0, false, { ...firstTurn, startedAt: null }), null);
});

test('the panel marks shown filters pressed and repaints the header once the earliest rows go', () => {
  const source = fs.readFileSync(new URL('../public/trace-panel.ts', import.meta.url), 'utf8');
  const filtersSource = source.slice(source.indexOf('function buildTraceFilters'), source.indexOf('function buildHeader'));
  const trimSource = source.slice(source.indexOf('function dropOldestRows'), source.indexOf('function showAppendedRecords'));

  assert.match(filtersSource, /String\(!isKindHidden\(hiddenTraceKinds, filter\.kind\)\)/);
  assert.ok(trimSource.indexOf('selectedTrace.hasDroppedEarliestRows = true;') < trimSource.indexOf('renderHeader();'));
});

test('the panel requests changed selections before rendering and drains queued replies', () => {
  const source = fs.readFileSync(new URL('../public/trace-panel.ts', import.meta.url), 'utf8');
  const selectSessionSource = source.slice(source.indexOf('function selectSession'), source.indexOf('function buildSessionSelector'));
  const setSessionsSource = source.slice(source.indexOf('export function setTraceSessions'), source.indexOf('export function refreshTraceView'));
  const responseSource = source.slice(source.indexOf('export function applyTraceResponse'), source.indexOf('export function applyTraceChanged'));

  assert.ok(selectSessionSource.indexOf('requestSelectedTrace();') < selectSessionSource.indexOf('renderPanel();'));
  assert.ok(setSessionsSource.indexOf('requestSelectedTrace();') < setSessionsSource.indexOf('renderPanel();'));
  assert.match(responseSource, /outcome === 'stale'[\s\S]*requestQueuedRefresh\(\)/);
  assert.match(responseSource, /outcome === 'prepend'[\s\S]*requestQueuedRefresh\(\)/);
});

test('the rendered prepend path builds one page in place and preserves scroll position', () => {
  const source = fs.readFileSync(new URL('../public/trace-panel.ts', import.meta.url), 'utf8');
  const prependSource = source.slice(source.indexOf('function applyPrependToRenderedTurns'), source.indexOf('function showPrependedRecords'));
  const showPrependSource = source.slice(source.indexOf('function showPrependedRecords'), source.indexOf('export function mountTraceView'));

  assert.match(prependSource, /turnsElement\.prepend\(newTurnsFragment\)/);
  assert.match(prependSource, /turnSections\.unshift\(\.\.\.newSections\)/);
  assert.match(prependSource, /paintTurnRowOffsets\(firstResidentRowsElement, firstResidentTurn\)/);
  assert.match(showPrependSource, /previousScrollTop \+ scrollElement\.scrollHeight - previousScrollHeight/);
  assert.match(showPrependSource, /prepend\.needsRerender/);
  assert.ok(showPrependSource.indexOf('renderPanel();') < showPrependSource.indexOf('previousScrollTop + scrollElement.scrollHeight'));
});

test('debug mode gates every trace entry point and exits hidden trace views', () => {
  const cardDomSource = fs.readFileSync(new URL('../public/session-card/card-dom.ts', import.meta.url), 'utf8');
  const lifecycleSource = fs.readFileSync(new URL('../public/session-card/lifecycle.ts', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../public/app.ts', import.meta.url), 'utf8');
  const phoneShellSource = fs.readFileSync(new URL('../public/phone/phone-shell.ts', import.meta.url), 'utf8');

  assert.match(cardDomSource, /for \(const listener of debugModeListeners\) listener\(_debugMode\)/);
  assert.match(cardDomSource, /ui\.btnTrace\.classList\.toggle\('visible', _debugMode\)/);
  assert.match(cardDomSource, /ui\.overflowMenu\.classList\.remove\('open'\)/);
  assert.match(lifecycleSource, /ui\.btnTrace\.classList\.toggle\('visible', isDebugModeEnabled\(\)\)/);
  assert.match(appSource, /onDebugModeChanged\(setTraceSurfaceAvailable\)/);
  assert.match(appSource, /tabTrace\.hidden = !isAvailable/);
  assert.match(appSource, /setPhoneScreenAvailable\('trace', isAvailable\)/);
  assert.match(appSource, /if \(isPhoneShellActive\(\)\) return;\s*if \(!isAvailable && getActiveView\(\) === 'trace'\) activateView\('focus'\)/);
  assert.match(appSource, /if \(!isTraceSurfaceAvailable\) return;/);
  assert.match(appSource, /function isViewAvailable\(view: string\) \{\s*return VIEW_TABS\.some\(\(viewTab\) => viewTab\.view === view && !viewTab\.tab\.hidden\);/);
  assert.match(appSource, /activateView\(isViewAvailable\(restoredView\) \? restoredView : 'focus', \{ persist: shouldPersistActiveView \}\)/);
  assert.match(phoneShellSource, /if \(!isAvailable && active && uiState\.snapshot\(\)\.phoneScreen === screenId\) showScreen\(BOARD\)/);
});

test('a saved trace view survives the startup restore and reopens once debug mode arrives', () => {
  const appSource = fs.readFileSync(new URL('../public/app.ts', import.meta.url), 'utf8');
  const startupRestoreSource = appSource.slice(appSource.indexOf('if (!initialSettingsTarget && !initialPlanTarget) {'), appSource.indexOf('mountPhoneShell({'));
  const traceSurfaceSource = appSource.slice(appSource.indexOf('function setTraceSurfaceAvailable'), appSource.indexOf('onDebugModeChanged('));

  assert.match(startupRestoreSource, /const canRestoreSavedView = isViewAvailable\(savedView\);/);
  assert.match(startupRestoreSource, /if \(!canRestoreSavedView\) savedViewAwaitingSurface = savedView;/);
  assert.match(startupRestoreSource, /activateView\(canRestoreSavedView \? savedView : 'focus', \{ persist: canRestoreSavedView \}\)/);
  assert.match(traceSurfaceSource, /if \(savedViewAwaitingSurface !== 'trace'\) return;\s*activateView\('trace'\);/);
  assert.match(appSource, /if \(persist\) savedViewAwaitingSurface = null;/);
});

test('a command-name tag left unclosed resolves without backtracking', async () => {
  const records = [record({ kind: 'expansion', text: `<command-name>${' '.repeat(100000)}` })];
  const startedAt = Date.now();
  const turns = await turnsOf(records);
  assert.ok(Date.now() - startedAt < 200);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].head, null);
  assert.deepEqual([turns[0].rows[0].tag, turns[0].rows[0].text], ['EXPANSION', 'context']);
});

test('a command name is read only from a single-line tag', async () => {
  const withLineBreak = await turnsOf([record({ kind: 'expansion', text: '<command-name>\n/review\n</command-name>' })]);
  assert.equal(withLineBreak[0].head, null);
  const padded = await turnsOf([record({ kind: 'expansion', text: '<command-name>  /review  </command-name>' })]);
  assert.deepEqual([padded[0].head?.tag, padded[0].head?.text], ['EXPANSION', '/review']);
});
