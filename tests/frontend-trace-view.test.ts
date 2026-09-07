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
  assert.equal(turns[1].head?.label, 'Prompt: first prompt');
  assert.equal(turns[2].head?.label, 'Prompt: second prompt');
  assert.equal(turns[2].rows[0].label, 'Assistant: second answer');
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
  assert.deepEqual(turns.map((turn) => turn.head?.label ?? null), [
    'Session: claude vendor-session',
    'Prompt: first prompt',
    'Expansion: /review',
    'Session: claude vendor-session',
  ]);
  assert.deepEqual(turns[2].rows.map((row) => row.label), ['Assistant: review answer']);
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
  assert.deepEqual(turns[0].rows.map((row) => row.label), ['Skill: release', 'Expansion: release', 'Expansion: context']);
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
  assert.equal(appends[1].head?.label, 'Prompt: second prompt');
  assert.equal(appends[0].rows[0].label, 'Bash result: 2 bytes');
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
  assert.equal(rows[0].label.startsWith('Bash: '), true);
  assert.equal(rows[0].label.endsWith('...'), true);
  assert.equal(rows[0].label.includes('second line'), false);
  assert.equal(rows[1].label, 'Bash result: 2 bytes, error, truncated');
  assert.equal(traceRecordBody(rows[0].record), JSON.stringify({ command }, null, 2));
});

test('thinking, assistant, notice and subagent rows have concise labels', async () => {
  const records = [
    record({ kind: 'thinking', text: 'reasoning\nmore' }),
    record({ kind: 'assistant', text: 'answer\nmore', agentId: 'a1', agentType: 'general-purpose' }),
    record({ kind: 'notice', text: 'skipped bytes' }),
  ];
  const rows = (await turnsOf(records))[0].rows;
  assert.equal(rows[0].label, 'Thinking: reasoning');
  assert.equal(rows[1].label, '[general-purpose] Assistant: answer');
  assert.equal(rows[2].label, 'Notice: skipped bytes');
  assert.equal(rows[2].isMuted, true);
});

test('a truncated prompt row label ends with a truncation marker', async () => {
  const rows = (await turnsOf([record({ kind: 'prompt', text: 'prompt', truncated: true })]))[0].head;
  assert.equal(rows?.label.endsWith(', truncated'), true);
});

test('a truncated tool call row keeps its detail field ahead of the truncation marker', async () => {
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
  assert.equal(rows[0].label, 'Write: /repo/src/big.ts, truncated');
});

test('a truncated raw row label ends with a truncation marker', async () => {
  const rows = (await turnsOf([record({ kind: 'raw', line: 'not json', truncated: true })]))[0].rows;
  assert.equal(rows[0].label, 'Raw: not json, truncated');
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

  assert.deepEqual(grouping.turns.map((turn) => turn.head?.label ?? null), ['Prompt: earlier prompt', 'Prompt: resident prompt']);
  assert.deepEqual(grouping.turns[0].rows.map((row) => row.label), ['Bash: npm test', 'Assistant: tail of the earlier turn']);
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
  assert.deepEqual(grouping.turns.map((turn) => turn.head?.label ?? null), ['Prompt: prompt 2', 'Prompt: prompt 3']);
  assert.equal(grouping.toolCallByUseId.has('bash-0'), false);
  assert.equal(grouping.toolCallByUseId.has('bash-3'), true);
  assert.deepEqual(trimTraceGrouping(grouping, 1), { droppedTurnCount: 1, droppedRowCount: 2 });
  assert.equal(grouping.turns.length, 1);
  assert.equal(grouping.turns[0].head?.label, 'Prompt: prompt 3');
  assert.equal(grouping.turns[0].rows.length, 0);
  assert.equal(grouping.turns[0].hasTrimmedRows, true);
});

test('a single oversized turn keeps its heading and newest rows within the ceiling', async () => {
  const { appendTraceRecords, createTraceGrouping, traceResidentRowCount, trimTraceGrouping } = await importCore();
  const grouping = createTraceGrouping();
  appendTraceRecords(grouping, [
    record({ kind: 'prompt', text: 'long turn' }),
    ...Array.from({ length: 8 }, (_, rowNumber) => record({ kind: 'assistant', text: `answer ${rowNumber}` })),
  ]);

  assert.deepEqual(trimTraceGrouping(grouping, 5), { droppedTurnCount: 0, droppedRowCount: 4 });
  assert.equal(grouping.turns[0].head?.label, 'Prompt: long turn');
  assert.deepEqual(grouping.turns[0].rows.map((row) => row.label), [
    'Assistant: answer 4',
    'Assistant: answer 5',
    'Assistant: answer 6',
    'Assistant: answer 7',
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
  assert.match(prependSource, /turnRowsElements\.unshift\(\.\.\.newRowsElements\)/);
  assert.match(showPrependSource, /previousScrollTop \+ scrollElement\.scrollHeight - previousScrollHeight/);
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
  const startupRestoreSource = appSource.slice(appSource.indexOf('if (!initialSettingsTarget) {'), appSource.indexOf('mountPhoneShell({'));
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
  assert.equal(turns[0].rows[0].label, 'Expansion: context');
});

test('a command name is read only from a single-line tag', async () => {
  const withLineBreak = await turnsOf([record({ kind: 'expansion', text: '<command-name>\n/review\n</command-name>' })]);
  assert.equal(withLineBreak[0].head, null);
  const padded = await turnsOf([record({ kind: 'expansion', text: '<command-name>  /review  </command-name>' })]);
  assert.equal(padded[0].head?.label, 'Expansion: /review');
});
