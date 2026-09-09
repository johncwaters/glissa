import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { TraceCheckpoint, TraceRecord } from '../shared/contracts/trace.ts';
import { createTraceWiring, pruneTraceFiles } from '../server/trace-wiring.ts';
import {
  MAX_PARTIAL_LINE_BYTES,
  MAX_REMEMBERED_SUBAGENTS,
  MAX_TRANSCRIPT_READ_BYTES,
} from '../server/core/trace-tail-core.ts';

const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-home-'));
process.env.CLAUDE_CONFIG_DIR = claudeHome;
const projectsRoot = path.join(claudeHome, 'projects');
fs.mkdirSync(projectsRoot, { recursive: true });

const POLL_MS = 2000;
const PRUNE_MS = 24 * 60 * 60 * 1000;

class TestTraceSession extends EventEmitter {
  id: string;

  constructor(id: string) {
    super();
    this.id = id;
  }
}

function silentLogger(): Pick<Console, 'log' | 'warn'> {
  return { log: () => {}, warn: () => {} };
}

function makeWorkspace(name: string): { configDirectory: string; projectDirectory: string } {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `glissa-trace-${name}-`));
  const projectDirectory = fs.mkdtempSync(path.join(projectsRoot, `${name}-`));
  return { configDirectory, projectDirectory };
}

function createHarness(
  configDirectory: string,
  nowMs = 10,
  logger: Pick<Console, 'log' | 'warn'> = silentLogger(),
  debug = false,
) {
  const timers: { fn: () => void; ms: number }[] = [];
  const wiring = createTraceWiring({
    configPath: path.join(configDirectory, 'config.json'),
    logger,
    debug,
    nowFn: () => nowMs,
    setIntervalFn: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      const handle = setTimeout(() => {}, 2 ** 30);
      handle.unref();
      return handle;
    },
  });

  async function fire(ms: number): Promise<void> {
    for (const timer of timers) {
      if (timer.ms !== ms) continue;
      timer.fn();
    }
    await wiring.whenIdle();
  }

  return {
    wiring,
    timers,
    poll: () => fire(POLL_MS),
    firePrune: () => fire(PRUNE_MS),
    tracePath: (glissaSessionId: string) => path.join(configDirectory, 'traces', `${glissaSessionId}.jsonl`),
    checkpointPath: (glissaSessionId: string) => path.join(configDirectory, 'traces', `${glissaSessionId}.checkpoint.json`),
  };
}

function transcriptLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function mainPrompt(text: string, uuid: string): string {
  return transcriptLine({
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: 'vendor-session',
    timestamp: '2026-08-22T18:47:28.724Z',
    message: { content: text },
  });
}

function skillToolCall(toolUseId: string): string {
  return transcriptLine({
    type: 'assistant',
    uuid: 'skill-call',
    parentUuid: null,
    sessionId: 'vendor-session',
    timestamp: '2026-08-22T18:47:28.724Z',
    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Skill', input: { skill: 'release' } }] },
  });
}

function skillExpansion(toolUseId: string): string {
  return transcriptLine({
    type: 'user',
    uuid: 'skill-expansion',
    parentUuid: null,
    sessionId: 'vendor-session',
    timestamp: '2026-08-22T18:47:29.724Z',
    isMeta: true,
    sourceToolUseID: toolUseId,
    message: { content: 'skill body' },
  });
}

function subagentAnswer(text: string, uuid = 'subagent-answer'): string {
  return transcriptLine({
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: 'vendor-session',
    agentId: 'a1',
    timestamp: '2026-08-22T18:47:35.724Z',
    message: { content: [{ type: 'text', text }] },
  });
}

function subagentStop(subagentPath: string) {
  return {
    event: 'subagentstop',
    payload: {
      session_id: 'vendor-session',
      agent_transcript_path: subagentPath,
      agent_id: 'a1',
      agent_type: 'general-purpose',
    },
  };
}

function readTrace(filePath: string) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => TraceRecord.parse(JSON.parse(line)));
}

function readCheckpoint(filePath: string) {
  return TraceCheckpoint.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function writeSubagentTranscript(projectDirectory: string, text: string): string {
  const subagentPath = path.join(projectDirectory, 'vendor-session', 'subagents', 'agent-a1.jsonl');
  fs.mkdirSync(path.dirname(subagentPath), { recursive: true });
  fs.writeFileSync(subagentPath, subagentAnswer(text), 'utf8');
  return subagentPath;
}

test('main and subagent transcript records append under the Glissa session id', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('capture');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = writeSubagentTranscript(projectDirectory, 'subagent answer');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);
  const appendedIds: string[] = [];
  harness.wiring.on('trace-appended', ({ id }: { id: string }) => appendedIds.push(id));

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('main prompt', 'prompt-id'), 'utf8');
  await harness.poll();
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'assistant']);
  assert.equal(records[0].kind === 'session' ? records[0].transcriptPath : null, transcriptPath);
  assert.equal(records[2].agentId, 'a1');
  assert.equal(records[2].agentType, 'general-purpose');
  assert.deepEqual(appendedIds, ['glissa-session-id', 'glissa-session-id', 'glissa-session-id']);

  const checkpoint = readCheckpoint(harness.checkpointPath('glissa-session-id'));
  assert.equal(checkpoint.offset, fs.statSync(transcriptPath).size);
  assert.deepEqual(checkpoint.ingestedSubagentPaths, []);
  assert.equal(checkpoint.subagentOffsetByPath[subagentPath], fs.statSync(subagentPath).size);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a draining poll logs debug details only when it appends transcript records', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('debug-drain');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const notes: string[] = [];
  const harness = createHarness(configDirectory, 10, {
    log: (message) => { notes.push(String(message)); },
    warn: () => {},
  }, true);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  const record = mainPrompt('main prompt', 'prompt-id');
  fs.appendFileSync(transcriptPath, record, 'utf8');
  await harness.poll();

  const offset = Buffer.byteLength(record);
  assert.deepEqual(notes, [
    `[trace] drained session=glissa-session-id records=1 bytes=${offset} offset=${offset}`,
  ]);

  notes.length = 0;
  await harness.poll();
  assert.deepEqual(notes, []);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a second SubagentStop appends only records added since the first stop', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('order');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = writeSubagentTranscript(projectDirectory, 'subagent answer');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('launched an agent', 'prompt-id'), 'utf8');
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();
  fs.appendFileSync(subagentPath, subagentAnswer('continued answer', 'subagent-answer-two'), 'utf8');
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'assistant', 'assistant']);
  assert.equal(records[1].kind === 'prompt' ? records[1].text : null, 'launched an agent');
  assert.deepEqual(records.slice(2).map((record) => record.uuid), ['subagent-answer', 'subagent-answer-two']);
  assert.equal(new Set(records.map((record) => record.uuid).filter(Boolean)).size, 3);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a subagent transcript larger than one chunk reaches EOF in one stop', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('multi-chunk-subagent');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = path.join(projectDirectory, 'agent-a1.jsonl');
  const lineCount = 7000;
  const transcript = Array.from(
    { length: lineCount },
    (_value, index) => subagentAnswer(`answer ${index}`, `subagent-answer-${index}`),
  ).join('');
  assert.ok(Buffer.byteLength(transcript) > MAX_TRANSCRIPT_READ_BYTES);
  fs.writeFileSync(subagentPath, transcript, 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  const assistantRecords = records.filter((record) => record.kind === 'assistant');
  assert.equal(assistantRecords.length, lineCount);
  assert.equal(new Set(assistantRecords.map((record) => record.uuid)).size, lineCount);
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).subagentOffsetByPath[subagentPath], Buffer.byteLength(transcript));

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a subagent line half-written at one stop is traced once when the next stop finds it complete', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('half-written-subagent');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = path.join(projectDirectory, 'agent-a1.jsonl');
  const settledLine = subagentAnswer('settled answer', 'subagent-answer-settled');
  const flushingLine = subagentAnswer('answer completed between stops', 'subagent-answer-flushing');
  const halfway = Math.floor(flushingLine.length / 2);
  fs.writeFileSync(subagentPath, `${settledLine}${flushingLine.slice(0, halfway)}`, 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  assert.deepEqual(
    readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind),
    ['session', 'assistant'],
  );
  assert.equal(
    readCheckpoint(harness.checkpointPath('glissa-session-id')).subagentOffsetByPath[subagentPath],
    Buffer.byteLength(settledLine),
  );

  fs.appendFileSync(subagentPath, flushingLine.slice(halfway), 'utf8');
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  const assistantRecords = records.filter((record) => record.kind === 'assistant');
  assert.deepEqual(
    assistantRecords.map((record) => record.uuid),
    ['subagent-answer-settled', 'subagent-answer-flushing'],
  );
  const flushed = assistantRecords[1];
  assert.equal(flushed && flushed.kind === 'assistant' ? flushed.text : null, 'answer completed between stops');
  assert.equal(records.some((record) => record.kind === 'raw'), false);
  assert.equal(
    readCheckpoint(harness.checkpointPath('glissa-session-id')).subagentOffsetByPath[subagentPath],
    fs.statSync(subagentPath).size,
  );

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a multibyte character spanning a subagent chunk boundary is traced intact', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('multibyte-subagent');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = path.join(projectDirectory, 'agent-a1.jsonl');
  const accentedText = `caf${String.fromCharCode(233)} answer`;
  const accentedLine = subagentAnswer(accentedText, 'subagent-answer-accented');
  const accentByteOffset = Buffer.from(accentedLine, 'utf8').indexOf(0xc3);
  const paddingOverhead = Buffer.byteLength(subagentAnswer('', 'subagent-answer-padding'), 'utf8');
  const paddingLine = subagentAnswer(
    'x'.repeat(MAX_TRANSCRIPT_READ_BYTES - 1 - accentByteOffset - paddingOverhead),
    'subagent-answer-padding',
  );
  assert.equal(Buffer.byteLength(paddingLine, 'utf8') + accentByteOffset, MAX_TRANSCRIPT_READ_BYTES - 1);
  fs.writeFileSync(subagentPath, `${paddingLine}${accentedLine}`, 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const assistantRecords = readTrace(harness.tracePath('glissa-session-id'))
    .filter((record) => record.kind === 'assistant');
  assert.deepEqual(
    assistantRecords.map((record) => record.uuid),
    ['subagent-answer-padding', 'subagent-answer-accented'],
  );
  const accented = assistantRecords[1];
  assert.equal(accented && accented.kind === 'assistant' ? accented.text : null, accentedText);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a skipped oversized subagent line is not re-read as a fragment on the next stop', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('oversized-subagent-skip');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = path.join(projectDirectory, 'agent-a1.jsonl');
  const skippedBytes = MAX_PARTIAL_LINE_BYTES + MAX_TRANSCRIPT_READ_BYTES;
  const answerAfterTheSkip = subagentAnswer('answer after the skip', 'subagent-answer-after');
  fs.writeFileSync(subagentPath, `${'x'.repeat(skippedBytes + 1)}\n${answerAfterTheSkip}`, 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const firstRecords = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(firstRecords.map((record) => record.kind), ['session', 'notice', 'assistant']);
  assert.equal(
    firstRecords[1] && firstRecords[1].kind === 'notice' ? firstRecords[1].text : null,
    `skipped ${skippedBytes} bytes of agent-a1.jsonl`,
  );
  assert.equal(
    readCheckpoint(harness.checkpointPath('glissa-session-id')).subagentOffsetByPath[subagentPath],
    fs.statSync(subagentPath).size,
  );

  fs.appendFileSync(subagentPath, subagentAnswer('answer after the stop', 'subagent-answer-later'), 'utf8');
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'notice', 'assistant', 'assistant']);
  assert.deepEqual(
    records.filter((record) => record.kind === 'assistant').map((record) => record.uuid),
    ['subagent-answer-after', 'subagent-answer-later'],
  );

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('an oversized subagent line still unterminated at the stop end never resumes mid-line', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('oversized-subagent-unterminated');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = path.join(projectDirectory, 'agent-a1.jsonl');
  const skippedBytes = MAX_PARTIAL_LINE_BYTES + MAX_TRANSCRIPT_READ_BYTES;
  fs.writeFileSync(subagentPath, 'x'.repeat(skippedBytes + 1), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  assert.deepEqual(
    readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind),
    ['session', 'notice'],
  );

  const answerAfterTheSkip = subagentAnswer('answer after the oversized line', 'subagent-answer-after');
  fs.appendFileSync(subagentPath, `xxxx\n${answerAfterTheSkip}`, 'utf8');
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.equal(records.some((record) => record.kind === 'raw'), false);
  assert.deepEqual(
    records.filter((record) => record.kind === 'assistant').map((record) => record.uuid),
    ['subagent-answer-after'],
  );
  assert.equal(
    readCheckpoint(harness.checkpointPath('glissa-session-id')).subagentOffsetByPath[subagentPath],
    fs.statSync(subagentPath).size,
  );

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a subagent transcript truncated to zero is read from the start once it regrows', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('truncated-subagent');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = path.join(projectDirectory, 'agent-a1.jsonl');
  fs.writeFileSync(subagentPath, subagentAnswer('answer one', 'subagent-answer-one'), 'utf8');
  const sizeBeforeTruncation = fs.statSync(subagentPath).size;
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  assert.equal(
    readCheckpoint(harness.checkpointPath('glissa-session-id')).subagentOffsetByPath[subagentPath],
    sizeBeforeTruncation,
  );

  fs.writeFileSync(subagentPath, '', 'utf8');
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).subagentOffsetByPath[subagentPath], 0);

  fs.writeFileSync(subagentPath, subagentAnswer('answer two', 'subagent-answer-two'), 'utf8');
  assert.equal(fs.statSync(subagentPath).size, sizeBeforeTruncation);
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  assert.deepEqual(
    readTrace(harness.tracePath('glissa-session-id'))
      .filter((record) => record.kind === 'assistant')
      .map((record) => record.uuid),
    ['subagent-answer-one', 'subagent-answer-two'],
  );

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a legacy checkpoint with no remembered offset resumes the subagent transcript at its end', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('legacy-subagent-eof');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = writeSubagentTranscript(projectDirectory, 'already ingested answer');
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await first.wiring.whenIdle();
  await first.wiring.stop();

  const checkpoint = readCheckpoint(first.checkpointPath('glissa-session-id'));
  const legacyCheckpoint = {
    transcriptPath: checkpoint.transcriptPath,
    vendorSessionId: checkpoint.vendorSessionId,
    offset: checkpoint.offset,
    ingestedSubagentPaths: [subagentPath],
    offsetByTranscriptPath: checkpoint.offsetByTranscriptPath,
    subagentOffsetByPath: {},
  };
  fs.writeFileSync(first.checkpointPath('glissa-session-id'), JSON.stringify(legacyCheckpoint), 'utf8');
  const sizeAtResume = fs.statSync(subagentPath).size;

  const second = createHarness(configDirectory);
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await second.wiring.whenIdle();
  secondSession.emit('hook-event', subagentStop(subagentPath));
  await second.wiring.whenIdle();

  assert.equal(readTrace(second.tracePath('glissa-session-id')).filter((record) => record.kind === 'assistant').length, 0);
  assert.equal(
    readCheckpoint(second.checkpointPath('glissa-session-id')).subagentOffsetByPath[subagentPath],
    sizeAtResume,
  );

  await second.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a legacy union checkpoint ignores paths already held in offsets and tails later additions', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('legacy-subagent-checkpoint');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = writeSubagentTranscript(projectDirectory, 'retained answer');
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await first.wiring.whenIdle();
  await first.wiring.stop();

  const checkpoint = readCheckpoint(first.checkpointPath('glissa-session-id'));
  const legacyCheckpoint = {
    transcriptPath: checkpoint.transcriptPath,
    vendorSessionId: checkpoint.vendorSessionId,
    offset: checkpoint.offset,
    ingestedSubagentPaths: [subagentPath],
    offsetByTranscriptPath: checkpoint.offsetByTranscriptPath,
    subagentOffsetByPath: { [subagentPath]: fs.statSync(subagentPath).size },
  };
  fs.writeFileSync(first.checkpointPath('glissa-session-id'), JSON.stringify(legacyCheckpoint), 'utf8');

  const second = createHarness(configDirectory);
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await second.wiring.whenIdle();
  secondSession.emit('hook-event', subagentStop(subagentPath));
  await second.wiring.whenIdle();
  assert.equal(readTrace(second.tracePath('glissa-session-id')).filter((record) => record.kind === 'assistant').length, 0);

  fs.appendFileSync(subagentPath, subagentAnswer('new answer', 'subagent-answer-new'), 'utf8');
  secondSession.emit('hook-event', subagentStop(subagentPath));
  await second.wiring.whenIdle();

  const assistantRecords = readTrace(second.tracePath('glissa-session-id'))
    .filter((record) => record.kind === 'assistant');
  assert.deepEqual(assistantRecords.map((record) => record.uuid), ['subagent-answer-new']);
  assert.equal(
    readCheckpoint(second.checkpointPath('glissa-session-id')).subagentOffsetByPath[subagentPath],
    fs.statSync(subagentPath).size,
  );

  await second.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a subagent path evicted from the remembered offsets is tailed again instead of skipped', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('subagent-eviction');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const crowdingPaths = Array.from(
    { length: MAX_REMEMBERED_SUBAGENTS },
    (_unused, index) => path.join(projectDirectory, `agent-crowding-${index}.jsonl`),
  );
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  for (const [index, crowdingPath] of crowdingPaths.entries()) {
    fs.writeFileSync(crowdingPath, subagentAnswer(`answer ${index}`, `subagent-answer-${index}`), 'utf8');
    session.emit('hook-event', subagentStop(crowdingPath));
  }
  await harness.wiring.whenIdle();

  const [oldestPath, evictedPath] = crowdingPaths;
  assert.ok(oldestPath && evictedPath);
  session.emit('hook-event', subagentStop(oldestPath));
  const newcomerPath = path.join(projectDirectory, 'agent-newcomer.jsonl');
  fs.writeFileSync(newcomerPath, subagentAnswer('newcomer answer', 'subagent-answer-newcomer'), 'utf8');
  session.emit('hook-event', subagentStop(newcomerPath));
  await harness.wiring.whenIdle();

  const afterCrowding = readCheckpoint(harness.checkpointPath('glissa-session-id'));
  assert.equal(afterCrowding.subagentOffsetByPath[evictedPath], undefined);
  assert.deepEqual(afterCrowding.ingestedSubagentPaths, []);

  fs.appendFileSync(evictedPath, subagentAnswer('answer after the eviction', 'subagent-answer-after'), 'utf8');
  session.emit('hook-event', subagentStop(evictedPath));
  await harness.wiring.whenIdle();

  const uuids = readTrace(harness.tracePath('glissa-session-id')).map((record) => record.uuid);
  assert.equal(uuids.includes('subagent-answer-after'), true);
  const afterReturn = readCheckpoint(harness.checkpointPath('glissa-session-id'));
  assert.equal(afterReturn.subagentOffsetByPath[evictedPath], fs.statSync(evictedPath).size);
  assert.deepEqual(afterReturn.ingestedSubagentPaths, []);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a subagent transcript outside the bound session directory is refused', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('refuse');
  const strayProject = fs.mkdtempSync(path.join(projectsRoot, 'stray-'));
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const strayPath = path.join(strayProject, 'agent-a1.jsonl');
  fs.writeFileSync(strayPath, subagentAnswer('stray answer'), 'utf8');
  const warnings: string[] = [];
  const harness = createHarness(configDirectory, 10, {
    log: () => {},
    warn: (message) => { warnings.push(String(message)); },
  });
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(strayPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'notice']);
  assert.equal(records[1].kind === 'notice' ? records[1].text : null, 'refused agent-a1.jsonl: outside-root');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[trace\] subagent transcript refused /);
  assert.match(warnings[0], /session=glissa-session-id/);
  assert.match(warnings[0], /reason=outside-root/);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a missing subagent leaves no record while another refusal in the same session still records', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('missing-and-refused');
  const strayProject = fs.mkdtempSync(path.join(projectsRoot, 'stray-'));
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const missingPath = path.join(projectDirectory, 'agent-gone.jsonl');
  const strayPath = path.join(strayProject, 'agent-a1.jsonl');
  fs.writeFileSync(strayPath, subagentAnswer('stray answer'), 'utf8');
  const warnings: string[] = [];
  const harness = createHarness(configDirectory, 10, {
    log: () => {},
    warn: (message) => { warnings.push(String(message)); },
  });
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(missingPath));
  session.emit('hook-event', subagentStop(missingPath));
  session.emit('hook-event', subagentStop(strayPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'notice']);
  assert.equal(records[1].kind === 'notice' ? records[1].text : null, 'refused agent-a1.jsonl: outside-root');
  assert.equal(warnings.filter((warning) => /reason=missing/.test(warning)).length, 1);
  assert.equal(warnings.filter((warning) => /reason=outside-root/.test(warning)).length, 1);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
  fs.rmSync(strayProject, { recursive: true, force: true });
});

test('a repeated refused subagent transcript warns once for its reason', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('repeated-refuse');
  const strayProject = fs.mkdtempSync(path.join(projectsRoot, 'stray-'));
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const strayPath = path.join(strayProject, 'agent-a1.jsonl');
  fs.writeFileSync(strayPath, subagentAnswer('stray answer'), 'utf8');
  const warnings: string[] = [];
  const harness = createHarness(configDirectory, 10, {
    log: () => {},
    warn: (message) => { warnings.push(String(message)); },
  });
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(strayPath));
  session.emit('hook-event', subagentStop(strayPath));
  await harness.wiring.whenIdle();

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reason=outside-root/);
  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'notice']);
  assert.equal(records[1].kind === 'notice' ? records[1].text : null, 'refused agent-a1.jsonl: outside-root');

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
  fs.rmSync(strayProject, { recursive: true, force: true });
});

test('a missing subagent transcript is refused as missing', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('missing-subagent');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  const subagentPath = path.join(projectDirectory, 'agent-a1.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const warnings: string[] = [];
  const harness = createHarness(configDirectory, 10, {
    log: () => {},
    warn: (message) => { warnings.push(String(message)); },
  });
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reason=missing/);
  assert.doesNotMatch(warnings[0], /reason=outside-root/);
  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session']);

  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();
  assert.equal(warnings.length, 1);
  assert.deepEqual(readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind), ['session']);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a bound transcript outside the Claude projects root leaves no record and is never read', async () => {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-outside-'));
  const strayDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-stray-'));
  const strayTranscript = path.join(strayDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(strayTranscript, mainPrompt('secret prompt', 'prompt-id'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: strayTranscript });
  await harness.wiring.whenIdle();
  await harness.poll();

  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), false);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
  fs.rmSync(strayDirectory, { recursive: true, force: true });
});

test('a transcript bound before file creation starts tracing when the file appears', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('before-create');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  const warnings: string[] = [];
  const harness = createHarness(configDirectory, 10, {
    log: () => {},
    warn: (message) => { warnings.push(String(message)); },
  });
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  await harness.poll();
  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), false);
  assert.deepEqual(warnings, []);

  fs.writeFileSync(transcriptPath, mainPrompt('first prompt', 'prompt-one'), 'utf8');
  await harness.poll();
  fs.appendFileSync(transcriptPath, mainPrompt('second prompt', 'prompt-two'), 'utf8');
  await harness.poll();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'prompt']);
  assert.equal(records[1].kind === 'prompt' ? records[1].text : null, 'first prompt');
  assert.equal(records[2].kind === 'prompt' ? records[2].text : null, 'second prompt');
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).offset, fs.statSync(transcriptPath).size);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a nonexistent transcript outside the Claude projects root is refused', async () => {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-missing-outside-'));
  const strayDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-missing-stray-'));
  const transcriptPath = path.join(strayDirectory, 'vendor-session.jsonl');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  fs.writeFileSync(transcriptPath, mainPrompt('secret prompt', 'prompt-id'), 'utf8');
  await harness.poll();

  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), false);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
  fs.rmSync(strayDirectory, { recursive: true, force: true });
});

test('a nonexistent transcript with a separator in its basename is refused', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('unsafe-basename');
  const transcriptPath = path.join(projectDirectory, 'vendor\\session.jsonl');
  const warnings: string[] = [];
  const harness = createHarness(configDirectory, 10, {
    log: () => {},
    warn: (message) => { warnings.push(String(message)); },
  });
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  await harness.poll();

  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[trace\] transcript refused /);
  assert.match(warnings[0], /session=glissa-session-id/);
  assert.match(warnings[0], /reason=outside-root/);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a named pipe under the projects root is refused without wedging the lane', { skip: process.platform === 'win32' }, async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('fifo');
  const fifoPath = path.join(projectDirectory, 'vendor-session.jsonl');
  execFileSync('mkfifo', [fifoPath]);
  const warnings: string[] = [];
  const harness = createHarness(configDirectory, 10, {
    log: () => {},
    warn: (message) => { warnings.push(String(message)); },
  });
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: fifoPath });
  await harness.wiring.whenIdle();
  await harness.poll();

  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[trace\] transcript refused /);
  assert.match(warnings[0], /session=glissa-session-id/);
  assert.match(warnings[0], /reason=not-a-regular-file/);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a directory at the transcript path is refused instead of left pending', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('directory-transcript');
  const directoryPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.mkdirSync(directoryPath);
  const warnings: string[] = [];
  const harness = createHarness(configDirectory, 10, {
    log: () => {},
    warn: (message) => { warnings.push(String(message)); },
  });
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: directoryPath });
  await harness.wiring.whenIdle();
  await harness.poll();

  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[trace\] transcript refused /);
  assert.match(warnings[0], /session=glissa-session-id/);
  assert.match(warnings[0], /reason=not-a-regular-file/);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a restart resumes at the checkpoint instead of replaying retained history', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('restart');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('stored prompt', 'prompt-id'), 'utf8');
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await first.wiring.whenIdle();
  await first.wiring.stop();

  const second = createHarness(configDirectory);
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await second.wiring.whenIdle();
  await second.poll();
  await second.wiring.stop();

  const records = readTrace(first.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'session']);

  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a skill expansion appended after restart retains the checkpointed call id', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('skill-expansion-restart');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  const toolUseId = 'toolu_skill';
  fs.writeFileSync(transcriptPath, skillToolCall(toolUseId), 'utf8');
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await first.wiring.whenIdle();
  await first.wiring.stop();

  fs.appendFileSync(transcriptPath, skillExpansion(toolUseId), 'utf8');
  const second = createHarness(configDirectory);
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await second.wiring.whenIdle();
  await second.wiring.stop();

  const expansion = readTrace(second.tracePath('glissa-session-id')).find((record) => record.kind === 'expansion');
  assert.equal(expansion?.kind, 'expansion');
  assert.equal(expansion?.kind === 'expansion' ? expansion.toolUseId : null, toolUseId);

  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a transcript shorter than the checkpoint restarts from zero and says so', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('reset');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('first prompt', 'prompt-one'), 'utf8');
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await first.wiring.whenIdle();
  await first.wiring.stop();

  fs.writeFileSync(transcriptPath, mainPrompt('short', 'prompt-two'), 'utf8');
  const second = createHarness(configDirectory);
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await second.wiring.whenIdle();
  await second.wiring.stop();

  const records = readTrace(first.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'session', 'prompt']);
  const reset = records[2];
  assert.equal(reset.kind === 'session' ? Boolean(reset.reason) : false, true);
  assert.equal(records[3].kind === 'prompt' ? records[3].text : null, 'short');

  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a rebind drains the old transcript before it follows the new one', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('rebind');
  const firstTranscript = path.join(projectDirectory, 'vendor-session.jsonl');
  const secondTranscript = path.join(projectDirectory, 'cleared-session.jsonl');
  fs.writeFileSync(firstTranscript, '', 'utf8');
  fs.writeFileSync(secondTranscript, mainPrompt('after the clear', 'prompt-two'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: firstTranscript });
  await harness.wiring.whenIdle();
  fs.appendFileSync(firstTranscript, mainPrompt('before the clear', 'prompt-one'), 'utf8');
  session.emit('claude-session-id', { id: 'cleared-session', vendor: 'claude', transcriptPath: secondTranscript });
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'session', 'prompt']);
  assert.equal(records[1].kind === 'prompt' ? records[1].text : null, 'before the clear');
  assert.equal(records[3].kind === 'prompt' ? records[3].text : null, 'after the clear');
  const checkpoint = readCheckpoint(harness.checkpointPath('glissa-session-id'));
  assert.equal(checkpoint.transcriptPath, secondTranscript);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('two terminals resumed onto one conversation keep their own trace files', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('shared-conversation');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('shared prompt', 'prompt-id'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const firstSession = new TestTraceSession('terminal-one');
  const secondSession = new TestTraceSession('terminal-two');
  harness.wiring.attachSession(firstSession);
  harness.wiring.attachSession(secondSession);

  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  firstSession.emit('exit', { exitCode: 0 });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('second prompt', 'prompt-two'), 'utf8');
  await harness.poll();

  assert.deepEqual(
    readTrace(harness.tracePath('terminal-one')).map((record) => record.kind),
    ['session', 'prompt'],
  );
  assert.deepEqual(
    readTrace(harness.tracePath('terminal-two')).map((record) => record.kind),
    ['session', 'prompt', 'prompt'],
  );

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('an exit and a teardown each drain what the transcript gained last', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('teardown');
  const exitTranscript = path.join(projectDirectory, 'exit-session.jsonl');
  const teardownTranscript = path.join(projectDirectory, 'teardown-session.jsonl');
  fs.writeFileSync(exitTranscript, '', 'utf8');
  fs.writeFileSync(teardownTranscript, '', 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const exitingSession = new TestTraceSession('exiting-session');
  const destroyedSession = new TestTraceSession('destroyed-session');
  harness.wiring.attachSession(exitingSession);
  harness.wiring.attachSession(destroyedSession);

  exitingSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: exitTranscript });
  destroyedSession.emit('claude-session-id', { id: 'other-session', vendor: 'claude', transcriptPath: teardownTranscript });
  await harness.wiring.whenIdle();
  fs.appendFileSync(exitTranscript, mainPrompt('written before the exit', 'prompt-one'), 'utf8');
  fs.appendFileSync(teardownTranscript, mainPrompt('written before the teardown', 'prompt-two'), 'utf8');
  exitingSession.emit('exit', { exitCode: 0 });
  exitingSession.emit('exit', { exitCode: 0 });
  destroyedSession.emit('teardown', { id: 'destroyed-session' });
  await harness.wiring.stop();

  assert.deepEqual(
    readTrace(harness.tracePath('exiting-session')).map((record) => record.kind),
    ['session', 'prompt'],
  );
  assert.deepEqual(
    readTrace(harness.tracePath('destroyed-session')).map((record) => record.kind),
    ['session', 'prompt'],
  );
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('stopping drains a session that never ended', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('shutdown');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('written at shutdown', 'prompt-id'), 'utf8');
  await harness.wiring.stop();

  assert.deepEqual(
    readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind),
    ['session', 'prompt'],
  );
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('an unsafe Glissa session id never becomes a trace path', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('unsafe');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('prompt', 'prompt-id'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('..');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();

  assert.equal(fs.existsSync(path.join(configDirectory, 'traces')), false);
  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('the age prune runs on start, on its interval, and spares a bound session', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('prune');
  const traceDirectory = path.join(configDirectory, 'traces');
  fs.mkdirSync(traceDirectory, { recursive: true });
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const harness = createHarness(configDirectory, Date.now());
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);
  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();

  const stalePath = path.join(traceDirectory, 'stale.jsonl');
  const staleCheckpointPath = path.join(traceDirectory, 'stale.checkpoint.json');
  const staleTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.writeFileSync(stalePath, '{}\n', 'utf8');
  fs.utimesSync(stalePath, staleTime, staleTime);
  for (const filePath of [harness.tracePath('glissa-session-id'), harness.checkpointPath('glissa-session-id')]) {
    fs.utimesSync(filePath, staleTime, staleTime);
  }
  await harness.wiring.start();
  await harness.wiring.whenIdle();

  assert.equal(fs.existsSync(stalePath), false);
  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), true);
  assert.equal(fs.existsSync(harness.checkpointPath('glissa-session-id')), true);
  assert.deepEqual(harness.timers.map((timer) => timer.ms), [PRUNE_MS, POLL_MS]);

  fs.writeFileSync(staleCheckpointPath, '{}\n', 'utf8');
  fs.utimesSync(staleCheckpointPath, staleTime, staleTime);
  await harness.firePrune();
  assert.equal(fs.existsSync(staleCheckpointPath), false);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('the age prune keeps files inside the retention window', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-retention-'));
  const oldPath = path.join(directory, 'old.jsonl');
  const currentPath = path.join(directory, 'current.jsonl');
  fs.writeFileSync(oldPath, '{}\n', 'utf8');
  fs.writeFileSync(currentPath, '{}\n', 'utf8');
  const now = Date.parse('2026-09-06T00:00:00.000Z');
  fs.utimesSync(oldPath, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));
  fs.utimesSync(currentPath, new Date(now - 6 * 24 * 60 * 60 * 1000), new Date(now - 6 * 24 * 60 * 60 * 1000));

  assert.equal(await pruneTraceFiles({ traceDirectory: directory, now }), 1);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(currentPath), true);
  fs.rmSync(directory, { recursive: true, force: true });
});


test('an append that fails keeps its records queued and leaves the checkpoint behind', {
  skip: process.getuid?.() === 0 ? 'root ignores file permissions' : false,
}, async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('append-failure');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('first prompt', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  const offsetBeforeFailure = readCheckpoint(harness.checkpointPath('glissa-session-id')).offset;

  fs.chmodSync(harness.tracePath('glissa-session-id'), 0o444);
  fs.appendFileSync(transcriptPath, mainPrompt('written while unwritable', 'prompt-two'), 'utf8');
  await harness.poll();

  assert.deepEqual(readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind), ['session', 'prompt']);
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).offset, offsetBeforeFailure);

  fs.chmodSync(harness.tracePath('glissa-session-id'), 0o600);
  await harness.poll();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'prompt']);
  assert.equal(records[2].kind === 'prompt' ? records[2].text : null, 'written while unwritable');
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).offset, fs.statSync(transcriptPath).size);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a batch appended without its checkpoint is not replayed on the next start', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('lost-checkpoint');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('appended before the crash', 'prompt-one'), 'utf8');
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await first.wiring.whenIdle();
  await first.wiring.stop();

  const stale = { ...readCheckpoint(first.checkpointPath('glissa-session-id')), offset: 0, offsetByTranscriptPath: {} };
  fs.writeFileSync(first.checkpointPath('glissa-session-id'), JSON.stringify(stale), 'utf8');

  const second = createHarness(configDirectory);
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await second.wiring.whenIdle();
  await second.wiring.stop();

  assert.deepEqual(
    readTrace(first.tracePath('glissa-session-id')).map((record) => record.kind),
    ['session', 'prompt', 'session'],
  );
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a 130000-byte final trace record cannot hide the committed resume offset', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('large-tail-record');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('before the large trace record', 'prompt-one'), 'utf8');
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await first.wiring.whenIdle();
  await first.wiring.stop();
  fs.rmSync(first.checkpointPath('glissa-session-id'));
  fs.appendFileSync(first.tracePath('glissa-session-id'), transcriptLine({
    ts: 10,
    uuid: 'large-call',
    parentUuid: null,
    vendorSessionId: 'vendor-session',
    kind: 'tool_call',
    toolUseId: 'call-large',
    name: 'LargeCall',
    input: 'x'.repeat(130_000),
  }));
  fs.appendFileSync(transcriptPath, mainPrompt('after the large trace record', 'prompt-two'), 'utf8');

  const second = createHarness(configDirectory);
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await second.wiring.whenIdle();

  const records = readTrace(first.tracePath('glissa-session-id'));
  assert.equal(records.filter((record) => record.kind === 'prompt').length, 2);
  assert.equal(records.filter((record) => record.kind === 'notice').length, 0);
  assert.equal(readCheckpoint(second.checkpointPath('glissa-session-id')).offset, fs.statSync(transcriptPath).size);

  await second.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a recovery without a checkpoint skips a transcript when its trace marker is outside the scan window', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('lost-checkpoint-tail');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  const paddingText = 'x'.repeat(4000);
  fs.writeFileSync(
    transcriptPath,
    Array.from({ length: 300 }, (_unused, index) => mainPrompt(paddingText, `prompt-${index}`)).join(''),
    'utf8',
  );
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await first.wiring.whenIdle();
  await first.wiring.stop();
  fs.rmSync(first.checkpointPath('glissa-session-id'));

  const warnings: string[] = [];
  const second = createHarness(configDirectory, 10, {
    log: () => {},
    warn: (message) => { warnings.push(String(message)); },
  });
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await second.wiring.whenIdle();

  const records = readTrace(first.tracePath('glissa-session-id'));
  assert.equal(records.filter((record) => record.kind === 'prompt').length, 300);
  assert.equal(
    records.filter((record) => record.kind === 'notice' && record.text === 'recovery could not establish the run, resuming at the transcript end').length,
    1,
  );
  assert.equal(warnings.filter((warning) => warning.startsWith('[trace] trace recovery fell back to the transcript end')).length, 1);

  await second.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a recovery on a transcript that appears after the bind notices the fallback to its end', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('deferred-recovery');
  const tracedTranscript = path.join(projectDirectory, 'vendor-session.jsonl');
  const laterTranscript = path.join(projectDirectory, 'later-session.jsonl');
  fs.writeFileSync(tracedTranscript, mainPrompt('traced before the checkpoint was lost', 'prompt-one'), 'utf8');
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const firstSession = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(firstSession);
  firstSession.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: tracedTranscript });
  await first.wiring.whenIdle();
  await first.wiring.stop();
  fs.rmSync(first.checkpointPath('glissa-session-id'));

  const warnings: string[] = [];
  const second = createHarness(configDirectory, 10, {
    log: () => {},
    warn: (message) => { warnings.push(String(message)); },
  });
  await second.wiring.start();
  const secondSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(secondSession);
  secondSession.emit('claude-session-id', { id: 'later-session', vendor: 'claude', transcriptPath: laterTranscript });
  await second.wiring.whenIdle();

  fs.writeFileSync(laterTranscript, mainPrompt('retained before the first open', 'prompt-two'), 'utf8');
  await second.poll();

  const records = readTrace(second.tracePath('glissa-session-id'));
  assert.equal(
    records.filter((record) => record.kind === 'notice' && record.text === 'recovery could not establish the run, resuming at the transcript end').length,
    1,
  );
  assert.equal(warnings.filter((warning) => warning.startsWith('[trace] trace recovery fell back to the transcript end')).length, 1);
  assert.equal(records.some((record) => record.kind === 'prompt' && record.text === 'retained before the first open'), false);

  await second.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('an empty trace file starts at the transcript beginning', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('empty-trace-recovery');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('first prompt', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  fs.mkdirSync(path.dirname(harness.tracePath('glissa-session-id')), { recursive: true });
  fs.writeFileSync(harness.tracePath('glissa-session-id'), '', 'utf8');
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);
  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();

  assert.deepEqual(readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind), ['session', 'prompt']);
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).offset, fs.statSync(transcriptPath).size);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a transcript line written between the teardown and the stop still lands', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('teardown-window');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  session.emit('teardown', { id: 'glissa-session-id' });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('written while the pty was reaped', 'prompt-one'), 'utf8');
  await harness.wiring.stop();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt']);
  assert.equal(records[1].kind === 'prompt' ? records[1].text : null, 'written while the pty was reaped');
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('an exit in the tick of the first vendor id leaves no tailer behind', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('exit-race');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('written before the exit', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('exit', { exitCode: 0 });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('written after the exit', 'prompt-two'), 'utf8');
  await harness.poll();

  assert.deepEqual(
    readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind),
    ['session', 'prompt'],
  );

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a teardown in the tick of the first vendor id aborts the queued bind', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('teardown-race');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('never traced', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('teardown', { id: 'glissa-session-id' });
  await harness.wiring.whenIdle();
  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();

  assert.equal(fs.existsSync(harness.tracePath('glissa-session-id')), false);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a rebind the validator refuses keeps the working binding', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('refused-rebind');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('before the refused rebind', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  session.emit('claude-session-id', {
    id: 'cleared-session',
    vendor: 'claude',
    transcriptPath: path.join(projectDirectory, 'not-on-disk-yet.jsonl'),
  });
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('after the refused rebind', 'prompt-two'), 'utf8');
  await harness.poll();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'prompt']);
  assert.equal(records[2].kind === 'prompt' ? records[2].text : null, 'after the refused rebind');
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).transcriptPath, transcriptPath);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a rebind to a path nested under an existing transcript keeps the working binding', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('nested-rebind');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, mainPrompt('before the nested rebind', 'prompt-one'), 'utf8');
  const subagentPath = writeSubagentTranscript(projectDirectory, 'subagent answer');
  const warnings: string[] = [];
  const harness = createHarness(configDirectory, 10, {
    log: () => {},
    warn: (message) => { warnings.push(String(message)); },
  });
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  await harness.wiring.whenIdle();
  session.emit('claude-session-id', {
    id: 'nested-session',
    vendor: 'claude',
    transcriptPath: path.join(transcriptPath, 'nested-session.jsonl'),
  });
  await harness.wiring.whenIdle();
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();
  fs.appendFileSync(transcriptPath, mainPrompt('after the nested rebind', 'prompt-two'), 'utf8');
  await harness.poll();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'assistant', 'prompt']);
  assert.equal(records[3].kind === 'prompt' ? records[3].text : null, 'after the nested rebind');
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).transcriptPath, transcriptPath);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[trace\] transcript refused /);
  assert.match(warnings[0], /reason=missing/);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a subagent refused while the rebound transcript is still missing leaves the checkpoint alone', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('refused-subagent-pending');
  const firstTranscript = path.join(projectDirectory, 'vendor-session.jsonl');
  const pendingTranscript = path.join(projectDirectory, 'pending-session.jsonl');
  const unflushedSubagent = path.join(projectDirectory, 'agent-a1.jsonl');
  const paddingText = 'x'.repeat(4000);
  fs.writeFileSync(
    firstTranscript,
    Array.from({ length: 300 }, (_unused, index) => mainPrompt(paddingText, `prompt-${index}`)).join(''),
    'utf8',
  );
  const first = createHarness(configDirectory);
  await first.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  first.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: firstTranscript });
  await first.wiring.whenIdle();
  session.emit('claude-session-id', { id: 'pending-session', vendor: 'claude', transcriptPath: pendingTranscript });
  await first.wiring.whenIdle();
  session.emit('hook-event', subagentStop(unflushedSubagent));
  await first.wiring.whenIdle();

  const checkpoint = readCheckpoint(first.checkpointPath('glissa-session-id'));
  assert.equal(checkpoint.transcriptPath, firstTranscript);
  assert.equal(checkpoint.offsetByTranscriptPath[firstTranscript], fs.statSync(firstTranscript).size);
  assert.ok(fs.statSync(first.tracePath('glissa-session-id')).size > 64 * 1024);

  const second = createHarness(configDirectory);
  await second.wiring.start();
  const resumedSession = new TestTraceSession('glissa-session-id');
  second.wiring.attachSession(resumedSession);
  resumedSession.emit('claude-session-id', {
    id: 'vendor-session',
    vendor: 'claude',
    transcriptPath: firstTranscript,
  });
  await second.wiring.whenIdle();

  const records = readTrace(first.tracePath('glissa-session-id'));
  assert.equal(records.filter((record) => record.kind === 'prompt').length, 300);
  assert.equal(records.filter((record) => record.kind === 'notice').length, 0);

  await second.wiring.stop();
  await first.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a rebind switches from the old transcript when the new transcript appears', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('pending-rebind');
  const firstTranscript = path.join(projectDirectory, 'vendor-session.jsonl');
  const secondTranscript = path.join(projectDirectory, 'cleared-session.jsonl');
  fs.writeFileSync(firstTranscript, mainPrompt('first conversation', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: firstTranscript });
  await harness.wiring.whenIdle();
  session.emit('claude-session-id', { id: 'cleared-session', vendor: 'claude', transcriptPath: secondTranscript });
  await harness.wiring.whenIdle();
  fs.appendFileSync(firstTranscript, mainPrompt('before the switch', 'prompt-two'), 'utf8');
  fs.writeFileSync(secondTranscript, mainPrompt('after the switch', 'prompt-three'), 'utf8');
  await harness.poll();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(
    records.map((record) => record.kind),
    ['session', 'prompt', 'prompt', 'session', 'prompt'],
  );
  assert.equal(records[2].kind === 'prompt' ? records[2].text : null, 'before the switch');
  assert.equal(records[4].kind === 'prompt' ? records[4].text : null, 'after the switch');
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).transcriptPath, secondTranscript);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('repeated rebinds to transcripts that do not exist keep one predecessor, not a chain', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('rebind-chain');
  const firstTranscript = path.join(projectDirectory, 'vendor-session.jsonl');
  const skippedTranscripts = ['second', 'third'].map((name) => path.join(projectDirectory, `${name}-session.jsonl`));
  const lastTranscript = path.join(projectDirectory, 'fourth-session.jsonl');
  fs.writeFileSync(firstTranscript, mainPrompt('first prompt', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: firstTranscript });
  await harness.wiring.whenIdle();
  for (const [index, transcriptPath] of [...skippedTranscripts, lastTranscript].entries()) {
    session.emit('claude-session-id', { id: `pending-session-${index}`, vendor: 'claude', transcriptPath });
    await harness.wiring.whenIdle();
  }

  fs.appendFileSync(firstTranscript, mainPrompt('late on the first', 'prompt-two'), 'utf8');
  for (const [index, transcriptPath] of skippedTranscripts.entries()) {
    fs.writeFileSync(transcriptPath, mainPrompt(`from the skipped ${index}`, `skipped-${index}`), 'utf8');
  }
  fs.writeFileSync(lastTranscript, mainPrompt('from the last', 'prompt-three'), 'utf8');
  await harness.poll();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'prompt', 'prompt', 'session', 'prompt']);
  assert.deepEqual(
    records.flatMap((record) => (record.kind === 'prompt' ? [record.text] : [])),
    ['first prompt', 'late on the first', 'from the last'],
  );
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).transcriptPath, lastTranscript);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a rebind keeps a predecessor whose transcript appeared since the last poll', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('rebind-late-open');
  const firstTranscript = path.join(projectDirectory, 'first-session.jsonl');
  const secondTranscript = path.join(projectDirectory, 'second-session.jsonl');
  const thirdTranscript = path.join(projectDirectory, 'third-session.jsonl');
  fs.writeFileSync(firstTranscript, mainPrompt('first prompt', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'first-session', vendor: 'claude', transcriptPath: firstTranscript });
  await harness.wiring.whenIdle();
  session.emit('claude-session-id', { id: 'second-session', vendor: 'claude', transcriptPath: secondTranscript });
  await harness.wiring.whenIdle();
  fs.writeFileSync(secondTranscript, mainPrompt('second prompt', 'prompt-two'), 'utf8');
  session.emit('claude-session-id', { id: 'third-session', vendor: 'claude', transcriptPath: thirdTranscript });
  await harness.wiring.whenIdle();
  fs.writeFileSync(thirdTranscript, mainPrompt('third prompt', 'prompt-three'), 'utf8');
  await harness.poll();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(
    records.flatMap((record) => (record.kind === 'prompt' ? [record.text] : [])),
    ['first prompt', 'second prompt', 'third prompt'],
  );
  assert.equal(readCheckpoint(harness.checkpointPath('glissa-session-id')).transcriptPath, thirdTranscript);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a transcript drained during a deferred bind is not replayed when the session returns to it', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('deferred-return');
  const firstTranscript = path.join(projectDirectory, 'vendor-session.jsonl');
  const secondTranscript = path.join(projectDirectory, 'cleared-session.jsonl');
  fs.writeFileSync(firstTranscript, mainPrompt('first prompt', 'prompt-one'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: firstTranscript });
  await harness.wiring.whenIdle();
  session.emit('claude-session-id', { id: 'cleared-session', vendor: 'claude', transcriptPath: secondTranscript });
  await harness.wiring.whenIdle();

  fs.appendFileSync(firstTranscript, mainPrompt('second prompt', 'prompt-two'), 'utf8');
  const paddingText = 'x'.repeat(4000);
  const paddingPrompts = Array.from(
    { length: 20 },
    (_unused, index) => mainPrompt(paddingText, `padding-${index}`),
  );
  fs.writeFileSync(secondTranscript, paddingPrompts.join(''), 'utf8');
  await harness.poll();

  const afterTheSwitch = readCheckpoint(harness.checkpointPath('glissa-session-id'));
  assert.equal(afterTheSwitch.transcriptPath, secondTranscript);
  assert.equal(afterTheSwitch.offsetByTranscriptPath[firstTranscript], fs.statSync(firstTranscript).size);
  assert.ok(fs.statSync(harness.tracePath('glissa-session-id')).size > 64 * 1024);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: firstTranscript });
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  const secondPrompts = records.filter((record) => record.kind === 'prompt' && record.text === 'second prompt');
  assert.equal(secondPrompts.length, 1);
  assert.equal(records[records.length - 1].kind, 'session');

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('returning to a conversation already traced resumes it instead of replaying it', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('return');
  const firstTranscript = path.join(projectDirectory, 'vendor-session.jsonl');
  const secondTranscript = path.join(projectDirectory, 'other-session.jsonl');
  fs.writeFileSync(firstTranscript, mainPrompt('first conversation', 'prompt-one'), 'utf8');
  fs.writeFileSync(secondTranscript, mainPrompt('second conversation', 'prompt-two'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: firstTranscript });
  await harness.wiring.whenIdle();
  session.emit('claude-session-id', { id: 'other-session', vendor: 'claude', transcriptPath: secondTranscript });
  await harness.wiring.whenIdle();
  fs.appendFileSync(firstTranscript, mainPrompt('back on the first', 'prompt-three'), 'utf8');
  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: firstTranscript });
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(
    records.map((record) => record.kind),
    ['session', 'prompt', 'session', 'prompt', 'session', 'prompt'],
  );
  assert.equal(records[5].kind === 'prompt' ? records[5].text : null, 'back on the first');
  const checkpoint = readCheckpoint(harness.checkpointPath('glissa-session-id'));
  assert.equal(checkpoint.offsetByTranscriptPath[secondTranscript], fs.statSync(secondTranscript).size);
  assert.equal(checkpoint.offsetByTranscriptPath[firstTranscript], fs.statSync(firstTranscript).size);

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('the subagent root follows the resolved transcript, not the path the hook handed over', {
  skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false,
}, async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('symlinked-transcript');
  const realDirectory = path.join(projectDirectory, 'real');
  fs.mkdirSync(realDirectory, { recursive: true });
  const realTranscript = path.join(realDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(realTranscript, '', 'utf8');
  const linkedTranscript = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.symlinkSync(realTranscript, linkedTranscript);
  const strayPath = path.join(projectDirectory, 'agent-a1.jsonl');
  fs.writeFileSync(strayPath, subagentAnswer('answer beside the link'), 'utf8');
  const containedPath = path.join(realDirectory, 'agent-a2.jsonl');
  fs.writeFileSync(containedPath, subagentAnswer('answer beside the transcript'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath: linkedTranscript });
  session.emit('hook-event', subagentStop(strayPath));
  await harness.wiring.whenIdle();
  session.emit('hook-event', subagentStop(containedPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'notice', 'assistant']);
  assert.equal(records[0].kind === 'session' ? records[0].transcriptPath : null, realTranscript);
  assert.equal(records[1].kind === 'notice' ? records[1].text : null, 'refused agent-a1.jsonl: outside-root');
  assert.equal(records[2].kind === 'assistant' ? records[2].text : null, 'answer beside the transcript');

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a transcript sitting in the projects root itself never opens a sidechain beside it', async () => {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-trace-root-transcript-'));
  const transcriptPath = path.join(projectsRoot, 'loose-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const siblingPath = path.join(projectsRoot, 'loose-agent-a1.jsonl');
  fs.writeFileSync(siblingPath, subagentAnswer('sibling of the projects root'), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(siblingPath));
  await harness.wiring.whenIdle();

  assert.deepEqual(readTrace(harness.tracePath('glissa-session-id')).map((record) => record.kind), ['session']);

  await harness.wiring.stop();
  fs.rmSync(transcriptPath, { force: true });
  fs.rmSync(siblingPath, { force: true });
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('a subagent transcript past the read bound leaves a notice, not a raw line', async () => {
  const { configDirectory, projectDirectory } = makeWorkspace('subagent-overflow');
  const transcriptPath = path.join(projectDirectory, 'vendor-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const subagentPath = path.join(projectDirectory, 'agent-a1.jsonl');
  fs.writeFileSync(subagentPath, 'x'.repeat(MAX_PARTIAL_LINE_BYTES + 1), 'utf8');
  const harness = createHarness(configDirectory);
  await harness.wiring.start();
  const session = new TestTraceSession('glissa-session-id');
  harness.wiring.attachSession(session);

  session.emit('claude-session-id', { id: 'vendor-session', vendor: 'claude', transcriptPath });
  session.emit('hook-event', subagentStop(subagentPath));
  await harness.wiring.whenIdle();

  const records = readTrace(harness.tracePath('glissa-session-id'));
  assert.deepEqual(records.map((record) => record.kind), ['session', 'notice']);
  assert.equal(records[1].kind === 'notice' ? records[1].text : null, 'skipped 8388609 bytes of agent-a1.jsonl');

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

after(() => {
  fs.rmSync(claudeHome, { recursive: true, force: true });
});

test('the lane serves a byte page of its own trace file and refuses an unsafe session id', async () => {
  const { configDirectory } = makeWorkspace('read-page');
  const harness = createHarness(configDirectory);
  const traceDirectory = path.join(configDirectory, 'traces');
  fs.mkdirSync(traceDirectory, { recursive: true });
  const record = {
    ts: 1,
    uuid: null,
    parentUuid: null,
    vendorSessionId: 'vendor-session',
    kind: 'assistant',
    text: 'answer',
  };
  const line = `${JSON.stringify(record)}\n`;
  fs.writeFileSync(harness.tracePath('glissa-session-id'), line, 'utf8');

  const page = await harness.wiring.readTracePage('glissa-session-id', { after: 0 });
  assert.deepEqual(page.records, [TraceRecord.parse(record)]);
  assert.equal(page.next, Buffer.byteLength(line));
  assert.equal(page.reset, false);
  assert.equal(page.path, harness.tracePath('glissa-session-id'));

  const refused = await harness.wiring.readTracePage('../escape', { after: 0 });
  assert.deepEqual(refused, { records: [], start: 0, next: 0, reset: false, path: '' });

  await harness.wiring.stop();
  fs.rmSync(configDirectory, { recursive: true, force: true });
});
