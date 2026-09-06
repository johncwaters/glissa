import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MAX_RAW_LINE_CHARS, TraceRecord } from '../shared/contracts/trace.ts';
import { DROPPED_LINE_TYPES, MAX_TOOL_RESULT_CHARS, traceRecordsFromTranscriptLine } from '../server/core/trace-core.ts';

const fixturePath = path.join(import.meta.dirname, 'fixtures', 'trace', 'claude-records.jsonl');
const fixtureLines = fs.readFileSync(fixturePath, 'utf8').trim().split('\n');
const context = { vendorSessionId: 'vendor-session', now: 1, skillToolUseIds: new Set<string>() };

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
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(MAX_TOOL_RESULT_CHARS) }] },
  }), { vendorSessionId: 'vendor-session', now: 1 });
  const [oversized] = traceRecordsFromTranscriptLine(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'y'.repeat(MAX_TOOL_RESULT_CHARS + 1) }] },
  }), { vendorSessionId: 'vendor-session', now: 1 });

  assert.equal(exact?.kind === 'tool_result' ? exact.truncated : null, false);
  assert.equal(oversized?.kind === 'tool_result' ? oversized.truncated : null, true);
  assert.equal(oversized?.kind === 'tool_result' ? oversized.content.length : null, MAX_TOOL_RESULT_CHARS);
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
