import test from 'node:test';
import assert from 'node:assert/strict';

import { TraceCheckpoint, TraceRecord } from '../shared/contracts/trace.ts';
import type { TraceRecord as TraceRecordType } from '../shared/contracts/trace.ts';

const base = {
  ts: 1,
  uuid: null,
  parentUuid: null,
  vendorSessionId: 'vendor-session',
};

test('every trace record variant round-trips through the discriminated union', () => {
  const records: TraceRecordType[] = [
    { ...base, kind: 'prompt', text: 'prompt' },
    { ...base, kind: 'expansion', text: 'expanded', toolUseId: 'toolu_1' },
    { ...base, kind: 'thinking', text: 'thinking' },
    { ...base, kind: 'assistant', text: 'answer' },
    { ...base, kind: 'tool_call', toolUseId: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
    { ...base, kind: 'tool_result', toolUseId: 'toolu_1', content: 'body', isError: false, truncated: false },
    { ...base, kind: 'session', vendor: 'claude', transcriptPath: '/tmp/session.jsonl' },
    { ...base, kind: 'session', vendor: 'claude', transcriptPath: '/tmp/session.jsonl', reason: 'reset' },
    { ...base, kind: 'notice', text: 'skipped 12 bytes of session.jsonl' },
    { ...base, kind: 'raw', line: '{}' },
    { ...base, kind: 'prompt', text: 'prompt', transcriptOffset: 4096 },
  ];

  for (const record of records) assert.deepEqual(TraceRecord.parse(record), record);
});

test('kind-specific fields and the raw line cap fail closed', () => {
  assert.equal(TraceRecord.safeParse({ ...base, kind: 'tool_call', name: 'Read', input: {} }).success, false);
  assert.equal(TraceRecord.safeParse({ ...base, kind: 'raw', line: 'x'.repeat(4001) }).success, false);
  assert.equal(TraceRecord.safeParse({ ...base, kind: 'notice', text: 'x'.repeat(4001) }).success, false);
  assert.equal(TraceRecord.safeParse({ ...base, kind: 'prompt', text: 'p', transcriptOffset: -1 }).success, false);
});

test('a checkpoint parses only with a path, a vendor session id and a whole offset', () => {
  const checkpoint = {
    transcriptPath: '/tmp/session.jsonl',
    vendorSessionId: 'vendor-session',
    offset: 4096,
    ingestedSubagentPaths: ['/tmp/session/subagents/agent-a1.jsonl'],
    offsetByTranscriptPath: { '/tmp/session.jsonl': 4096 },
  };

  assert.deepEqual(TraceCheckpoint.parse(checkpoint), checkpoint);
  assert.equal(TraceCheckpoint.safeParse({ ...checkpoint, offset: -1 }).success, false);
  assert.equal(TraceCheckpoint.safeParse({ ...checkpoint, offset: 1.5 }).success, false);
  assert.equal(TraceCheckpoint.safeParse({ ...checkpoint, transcriptPath: '' }).success, false);
  assert.equal(TraceCheckpoint.safeParse({ ...checkpoint, ingestedSubagentPaths: undefined }).success, false);
  assert.equal(TraceCheckpoint.safeParse({ ...checkpoint, offsetByTranscriptPath: { '/tmp/a.jsonl': -1 } }).success, false);
  assert.deepEqual(
    TraceCheckpoint.parse({ ...checkpoint, offsetByTranscriptPath: undefined }).offsetByTranscriptPath,
    {},
  );
});
