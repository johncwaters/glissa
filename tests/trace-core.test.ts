import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MAX_RAW_LINE_CHARS, TraceRecord } from '../shared/contracts/trace.ts';
import type { TraceRecord as TraceRecordType } from '../shared/contracts/trace.ts';
import { DROPPED_LINE_TYPES, MAX_TRACE_BODY_CHARS, traceRecordsFromTranscriptLine } from '../server/core/trace-core.ts';
import { MAX_SESSION_TRACE_READ_BYTES } from '../server/core/session-trace-core.ts';
import { toolDetailLine } from '../shared/tool-detail.ts';

const fixturePath = path.join(import.meta.dirname, 'fixtures', 'trace', 'claude-records.jsonl');
const fixtureLines = fs.readFileSync(fixturePath, 'utf8').trim().split('\n');
const context = { vendorSessionId: 'vendor-session', now: 1, skillToolUseIds: new Set<string>() };

function traceTextLength(record: TraceRecordType | undefined): number | null {
  if (!record) return null;
  if (record.kind === 'prompt' || record.kind === 'expansion' || record.kind === 'thinking' || record.kind === 'assistant') return record.text.length;
  return null;
}

test('real Claude transcript shapes map to normalized trace records', () => {
  const records = fixtureLines.flatMap((line) => {
    const mapped = traceRecordsFromTranscriptLine(line, context);
    for (const record of mapped) {
      if (record.kind === 'tool_call' && record.name === 'Skill') context.skillToolUseIds.add(record.toolUseId);
    }
    return mapped;
  });

  assert.deepEqual(records.map((record) => record.kind), [
    'prompt', 'thinking', 'assistant', 'tool_call', 'tool_result', 'expansion', 'expansion', 'expansion',
    'thinking', 'assistant', 'tool_call',
  ]);
  assert.equal(records[0]?.kind === 'prompt' ? records[0].text : null, 'short prompt');
  assert.equal(records[1]?.kind === 'thinking' ? records[1].text : null, 'short reasoning');
  assert.equal(records[2]?.kind === 'assistant' ? records[2].text : null, 'short answer');
  assert.deepEqual(records[3]?.kind === 'tool_call' ? records[3].input : null, { skill: 'placeholder' });
  assert.equal(records[4]?.kind === 'tool_result' ? records[4].toolUseId : null, 'toolu_skill');
  assert.equal(records[5]?.kind === 'expansion' ? records[5].toolUseId : null, 'toolu_skill');
  assert.equal(records[6]?.kind === 'expansion' ? records[6].text : null, 'short injected context');
  assert.equal(records[6]?.kind === 'expansion' ? records[6].toolUseId : 'absent', undefined);
  assert.equal(records[7]?.kind === 'expansion' ? records[7].toolUseId : 'absent', undefined);
  for (const record of records) assert.equal(TraceRecord.safeParse(record).success, true);
});

test('an assistant line with thinking, text and a tool call keeps every block', () => {
  const mixedLine = fixtureLines[fixtureLines.length - 1];
  const records = traceRecordsFromTranscriptLine(mixedLine, {
    vendorSessionId: 'vendor-session',
    now: 1,
    skillToolUseIds: new Set<string>(),
  });

  assert.deepEqual(records.map((record) => record.kind), ['thinking', 'assistant', 'tool_call']);
  assert.equal(records[0]?.kind === 'thinking' ? records[0].text : null, 'short plan');
  assert.equal(records[1]?.kind === 'assistant' ? records[1].text : null, 'short preamble');
  assert.equal(records[2]?.kind === 'tool_call' ? records[2].name : null, 'Read');
  for (const record of records) assert.equal(record.uuid, 'mixed-blocks-uuid');
});

test('the no-debug-value table and compaction summaries are dropped', () => {
  for (const type of DROPPED_LINE_TYPES) {
    const records = traceRecordsFromTranscriptLine(JSON.stringify({ type }), {
      vendorSessionId: 'vendor-session',
      now: 1,
    });
    assert.deepEqual(records, [], type);
  }
  assert.deepEqual(traceRecordsFromTranscriptLine(JSON.stringify({
    type: 'user',
    isCompactSummary: true,
    message: { content: 'summary' },
  }), { vendorSessionId: 'vendor-session', now: 1 }), []);
});

test('tool results are capped and marked only when content crosses the cap', () => {
  const [exact] = traceRecordsFromTranscriptLine(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(MAX_TRACE_BODY_CHARS) }] },
  }), { vendorSessionId: 'vendor-session', now: 1 });
  const [oversized] = traceRecordsFromTranscriptLine(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'y'.repeat(MAX_TRACE_BODY_CHARS + 1) }] },
  }), { vendorSessionId: 'vendor-session', now: 1 });

  assert.equal(exact?.kind === 'tool_result' ? exact.truncated : null, false);
  assert.equal(oversized?.kind === 'tool_result' ? oversized.truncated : null, true);
  assert.equal(oversized?.kind === 'tool_result' ? oversized.content.length : null, MAX_TRACE_BODY_CHARS);
});

test('text bodies at and above the cap retain their truncation state', () => {
  const exactText = 'x'.repeat(MAX_TRACE_BODY_CHARS);
  const oversizedText = 'y'.repeat(MAX_TRACE_BODY_CHARS + 1);
  const sourceLines = [
    {
      name: 'prompt',
      exact: { type: 'user', message: { content: exactText } },
      oversized: { type: 'user', message: { content: oversizedText } },
    },
    {
      name: 'assistant',
      exact: { type: 'assistant', message: { content: [{ type: 'text', text: exactText }] } },
      oversized: { type: 'assistant', message: { content: [{ type: 'text', text: oversizedText }] } },
    },
    {
      name: 'thinking',
      exact: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: exactText }] } },
      oversized: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: oversizedText }] } },
    },
    {
      name: 'expansion',
      exact: { type: 'user', isMeta: true, message: { content: exactText } },
      oversized: { type: 'user', isMeta: true, message: { content: oversizedText } },
    },
  ];

  for (const source of sourceLines) {
    const [exact] = traceRecordsFromTranscriptLine(JSON.stringify(source.exact), context);
    const [oversized] = traceRecordsFromTranscriptLine(JSON.stringify(source.oversized), context);
    assert.equal(exact?.kind, source.name);
    assert.equal(oversized?.kind, source.name);
    assert.equal(exact?.truncated, undefined);
    assert.equal(oversized?.truncated, true);
    assert.equal(traceTextLength(exact), MAX_TRACE_BODY_CHARS);
    assert.equal(traceTextLength(oversized), MAX_TRACE_BODY_CHARS);
  }
});

test('tool call string inputs at and above the cap retain their truncation state', () => {
  const exactInput = 'x'.repeat(MAX_TRACE_BODY_CHARS);
  const oversizedInput = 'y'.repeat(MAX_TRACE_BODY_CHARS + 1);
  const exactLine = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_exact', name: 'Read', input: exactInput }] },
  });
  const oversizedLine = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_oversized', name: 'Read', input: oversizedInput }] },
  });
  const [exact] = traceRecordsFromTranscriptLine(exactLine, context);
  const [oversized] = traceRecordsFromTranscriptLine(oversizedLine, context);

  assert.equal(exact?.kind, 'tool_call');
  assert.equal(oversized?.kind, 'tool_call');
  assert.equal(exact?.kind === 'tool_call' ? exact.input : null, exactInput);
  assert.equal(exact?.truncated, undefined);
  assert.equal(oversized?.truncated, true);
  const storedOversizedInput = oversized?.kind === 'tool_call' ? oversized.input : null;
  assert.equal(typeof storedOversizedInput, 'string');
  if (typeof storedOversizedInput !== 'string') assert.fail('oversized input did not become text');
  assert.equal(storedOversizedInput.length, MAX_TRACE_BODY_CHARS);
});

test('an oversized tool call object input keeps its shape and cuts only the long property', () => {
  const filePath = '/repo/src/big.ts';
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: 'toolu_write',
        name: 'Write',
        input: { file_path: filePath, content: 'c'.repeat(MAX_TRACE_BODY_CHARS + 1), attempt: 2 },
      }],
    },
  });
  const [written] = traceRecordsFromTranscriptLine(line, context);

  assert.equal(written?.kind, 'tool_call');
  assert.equal(written?.truncated, true);
  const storedInput = written?.kind === 'tool_call' ? written.input : null;
  assert.equal(typeof storedInput === 'object' && storedInput !== null && !Array.isArray(storedInput), true);
  const inputFields = storedInput as Record<string, unknown>;
  assert.equal(inputFields.file_path, filePath);
  assert.equal(inputFields.attempt, 2);
  assert.equal(typeof inputFields.content === 'string' ? inputFields.content.length : null, MAX_TRACE_BODY_CHARS);
  assert.equal(toolDetailLine('Write', storedInput), filePath);
});

test('a tool call object input under the cap is stored unchanged', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/repo/src/small.ts', offset: 10 } }] },
  });
  const [read] = traceRecordsFromTranscriptLine(line, context);

  assert.equal(read?.truncated, undefined);
  assert.deepEqual(read?.kind === 'tool_call' ? read.input : null, { file_path: '/repo/src/small.ts', offset: 10 });
});

test('a tool call input whose nested array blows the cap is stored as bounded text that fits one trace read page', () => {
  const todos = Array.from({ length: 2000 }, (_todo, index) => ({ content: `t${index}`.padEnd(100, 'o'), status: 'pending' }));
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_todos', name: 'TodoWrite', input: { todos } }] },
  });
  const [written] = traceRecordsFromTranscriptLine(line, context);

  assert.equal(written?.kind, 'tool_call');
  assert.equal(written?.truncated, true);
  const storedInput = written?.kind === 'tool_call' ? written.input : null;
  assert.equal(typeof storedInput, 'string');
  assert.equal(typeof storedInput === 'string' ? storedInput.length : null, MAX_TRACE_BODY_CHARS);
  assert.ok(JSON.stringify(written).length < MAX_SESSION_TRACE_READ_BYTES);
  assert.equal(TraceRecord.safeParse(written).success, true);
});

test('a tool call input of many oversized properties is stored as bounded text that fits one trace read page', () => {
  const wideInput = Object.fromEntries(
    Array.from({ length: 12 }, (_property, index) => [`parameter_${index}`, 'w'.repeat(MAX_TRACE_BODY_CHARS + 1)]),
  );
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_wide', name: 'mcp__vendor__wide', input: wideInput }] },
  });
  const [written] = traceRecordsFromTranscriptLine(line, context);

  assert.equal(written?.truncated, true);
  const storedInput = written?.kind === 'tool_call' ? written.input : null;
  assert.equal(typeof storedInput === 'string' ? storedInput.length : null, MAX_TRACE_BODY_CHARS);
  assert.ok(JSON.stringify(written).length < MAX_SESSION_TRACE_READ_BYTES);
});

test('a bounded tool call input keeps a literal proto key as an own property', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: 'toolu_proto',
        name: 'Write',
        input: { ['__proto__']: 'polluted', content: 'p'.repeat(MAX_TRACE_BODY_CHARS + 1) },
      }],
    },
  });
  const [written] = traceRecordsFromTranscriptLine(line, context);

  assert.equal(written?.truncated, true);
  const storedInput = written?.kind === 'tool_call' ? written.input : null;
  assert.equal(typeof storedInput === 'object' && storedInput !== null, true);
  const inputFields = storedInput as Record<string, unknown>;
  assert.equal(Object.hasOwn(inputFields, '__proto__'), true);
  assert.equal(Object.getOwnPropertyDescriptor(inputFields, '__proto__')?.value, 'polluted');
  assert.equal(Object.getPrototypeOf(inputFields), Object.prototype);
  assert.equal(typeof inputFields.content === 'string' ? inputFields.content.length : null, MAX_TRACE_BODY_CHARS);
});

test('a raw line cut at the raw cap is marked as truncated', () => {
  const [cut] = traceRecordsFromTranscriptLine('not json '.repeat(MAX_RAW_LINE_CHARS), context);
  const [whole] = traceRecordsFromTranscriptLine('not json', context);

  assert.equal(cut?.kind, 'raw');
  assert.equal(cut?.kind === 'raw' ? cut.line.length : null, MAX_RAW_LINE_CHARS);
  assert.equal(cut?.truncated, true);
  assert.equal(whole?.kind, 'raw');
  assert.equal(whole?.truncated, undefined);
});

test('a record holding a body at the cap still fits inside one trace read page', () => {
  const [worstCase] = traceRecordsFromTranscriptLine(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: String.fromCharCode(1).repeat(MAX_TRACE_BODY_CHARS) }] },
  }), context);

  assert.equal(worstCase?.kind, 'tool_result');
  assert.ok(JSON.stringify(worstCase).length < MAX_SESSION_TRACE_READ_BYTES);
});

test('an assistant line containing only an empty thinking block yields no records', () => {
  const records = traceRecordsFromTranscriptLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: '' }] },
  }), context);
  assert.deepEqual(records, []);
});

test('an assistant line skips empty thinking blocks and retains non-empty blocks', () => {
  const records = traceRecordsFromTranscriptLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: '' }, { type: 'thinking', thinking: 'reasoning' }] },
  }), context);
  assert.deepEqual(records.map((record) => record.kind), ['thinking']);
  assert.equal(records[0]?.kind === 'thinking' ? records[0].text : null, 'reasoning');
});

test('an assistant line without a recognizable block remains raw', () => {
  const [record] = traceRecordsFromTranscriptLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'image', source: 'unrecognized' }] },
  }), context);
  assert.equal(record?.kind, 'raw');
});

test('unrecognised and malformed lines become bounded raw records', () => {
  const [changed] = traceRecordsFromTranscriptLine(JSON.stringify({
    type: 'new-vendor-shape',
    uuid: 'raw-uuid',
    parentUuid: null,
    sessionId: 'line-session',
    timestamp: '2026-08-22T18:47:28.724Z',
  }), { vendorSessionId: 'context-session', now: 1 });
  const [malformed] = traceRecordsFromTranscriptLine(`not-json-${'x'.repeat(MAX_RAW_LINE_CHARS)}`, {
    vendorSessionId: 'context-session',
    now: 2,
  });

  assert.equal(changed?.kind, 'raw');
  assert.equal(changed?.vendorSessionId, 'line-session');
  assert.equal(malformed?.kind === 'raw' ? malformed.line.length : null, MAX_RAW_LINE_CHARS);
});

test('subagent identity from the line and type from context survive mapping', () => {
  const [record] = traceRecordsFromTranscriptLine(JSON.stringify({
    type: 'assistant',
    uuid: 'subagent-uuid',
    parentUuid: null,
    sessionId: 'vendor-session',
    agentId: 'agent-line-id',
    message: { content: [{ type: 'text', text: 'subagent answer' }] },
  }), {
    vendorSessionId: 'vendor-session',
    now: 1,
    agentId: 'agent-context-id',
    agentType: 'general-purpose',
  });

  assert.equal(record?.agentId, 'agent-line-id');
  assert.equal(record?.agentType, 'general-purpose');
});
