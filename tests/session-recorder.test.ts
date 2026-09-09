import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRecorder, createRecorder } from '../session/session-recorder.ts';
import { Session } from '../session/sessions.ts';
import { replayDetection } from '../detection/replay.ts';
import { parseRecording } from '../detection/replay.ts';
import { projectHookPayload } from '../session/core/hook-payload-projection.ts';
import { STATES } from '../shared/states.ts';
function makeBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-recorder-'));
}

function readLines(filepath: string): Record<string, unknown>[] {
  const raw = fs.readFileSync(filepath, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function findRecordingFile(baseDir: string, name: string) {
  const entries = fs.readdirSync(baseDir).filter((f) => f.startsWith(`${name}-`) && f.endsWith('.jsonl'));
  assert.equal(entries.length, 1, 'exactly one recording file expected');
  return path.join(baseDir, entries[0]);
}

function closeAndFlush(recorder: SessionRecorder) {
  const stream = recorder._stream;
  if (!stream) {
    recorder.close();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    stream.once('finish', () => resolve());
    recorder.close();
  });
}

test('round-trips header, data, hook, state, input, resize, footer in write order', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'roundtrip-session', baseDir, recordData: true });
    recorder.open();

    recorder.writeHeader({ cols: 100, rows: 30, foo: 'bar' });
    recorder.writeData('hello world');
    recorder.writeHook('Stop', { reason: 'turn-end' });
    recorder.writeState('RUNNING', 'COMPLETE', 'task_complete', { via: 'hook' });
    recorder.writeDecision({ ts: 1234, kind: 'gate', decision: 'release', active: 0, quietMs: 10500 });
    recorder.writeInput('ls -la\n');
    recorder.writeResize(120, 40);
    recorder.writeFooter('exit', 0);
    await closeAndFlush(recorder);

    const filepath = findRecordingFile(baseDir, 'roundtrip-session');
    const records = readLines(filepath);

    assert.equal(records.length, 8);
    assert.deepEqual(
      records.map((r) => r.type),
      ['header', 'data', 'hook', 'state', 'decision', 'input', 'resize', 'footer'],
    );

    const [header, data, hook, state, decision, input, resize, footer] = records;

    assert.equal(header.version, 2);
    assert.equal(header.session, 'roundtrip-session');
    assert.equal(header.cols, 100);
    assert.equal(header.rows, 30);
    assert.deepEqual(header.config, { cols: 100, rows: 30, foo: 'bar' });
    assert.equal(typeof header.startedAt, 'number');

    assert.equal(data.data, 'hello world');
    assert.equal(data.len, 'hello world'.length);
    assert.equal(typeof data.ts, 'number');

    assert.equal(hook.event, 'Stop');
    assert.deepEqual(hook.payload, { reason: 'turn-end' });

    assert.equal(state.from, 'RUNNING');
    assert.equal(state.to, 'COMPLETE');
    assert.equal(state.event, 'task_complete');
    assert.deepEqual(state.detail, { via: 'hook' });

    assert.equal(decision.kind, 'gate');
    assert.equal(decision.decision, 'release');
    assert.equal(decision.quietMs, 10500);
    assert.equal(decision.ts, 1234, 'the entry keeps the timestamp the decision was made at');

    assert.equal(input.data, 'ls -la\n');

    assert.equal(resize.cols, 120);
    assert.equal(resize.rows, 40);

    assert.equal(footer.reason, 'exit');
    assert.equal(footer.exitCode, 0);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('writeHeader defaults cols/rows to 80x24 when config omits them', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'default-dims', baseDir, recordData: true });
    recorder.open();
    recorder.writeHeader({});
    await closeAndFlush(recorder);

    const filepath = findRecordingFile(baseDir, 'default-dims');
    const [header] = readLines(filepath);
    assert.equal(header.cols, 80);
    assert.equal(header.rows, 24);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('writeHook and writeFooter accept missing payload/exitCode and record null', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'nullable-fields', baseDir, recordData: true });
    recorder.open();
    recorder.writeHook('SessionEnd', null);
    recorder.writeFooter('kill', null);
    await closeAndFlush(recorder);

    const filepath = findRecordingFile(baseDir, 'nullable-fields');
    const [hook, footer] = readLines(filepath);
    assert.equal(hook.payload, null);
    assert.equal(footer.exitCode, null);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('timestamps are monotonic non-decreasing across sequential writes', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'ts-order', baseDir, recordData: true });
    recorder.open();
    recorder.writeData('a');
    recorder.writeData('b');
    recorder.writeData('c');
    await closeAndFlush(recorder);

    const filepath = findRecordingFile(baseDir, 'ts-order');
    const records = readLines(filepath);
    for (let i = 1; i < records.length; i++) {
      assert.ok(Number(records[i].ts) >= Number(records[i - 1].ts), 'timestamps must not decrease');
    }
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('close is idempotent and safe before open', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'idempotent-close', baseDir, recordData: true });
    recorder.close();
    recorder.close();

    const recorder2 = new SessionRecorder({ name: 'idempotent-close-2', baseDir, recordData: true });
    recorder2.open();
    recorder2.writeData('x');
    await closeAndFlush(recorder2);
    recorder2.close();

    const filepath = findRecordingFile(baseDir, 'idempotent-close-2');
    const records = readLines(filepath);
    assert.equal(records.length, 1);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('writes after close are silently dropped (no throw, file unchanged)', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'post-close-write', baseDir, recordData: true });
    recorder.open();
    recorder.writeData('kept');
    await closeAndFlush(recorder);
    recorder.writeData('dropped');
    recorder.writeFooter('late', 1);

    const filepath = findRecordingFile(baseDir, 'post-close-write');
    const records = readLines(filepath);
    assert.equal(records.length, 1);
    assert.equal(records[0].data, 'kept');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('signals mode records hooks and state transitions but no PTY bytes, input or resizes', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'signals-only', baseDir });
    recorder.open();
    recorder.writeHeader({ cols: 80, rows: 24 });
    recorder.writeData('lots and lots of raw pty bytes');
    recorder.writeInput('secret typing');
    recorder.writeResize(120, 40);
    recorder.writeHook('Stop', { session_id: 'abc', background_tasks: [{ id: 't1', type: 'teammate', status: 'running' }] });
    recorder.writeDecision({ ts: 7, kind: 'signal', signal: 'ready', source: 'hook', active: 1, action: 'gate-held' });
    recorder.writeState('RUNNING', 'COMPLETE', 'task_complete', { source: 'hook', signal: 'ready', deferred: true });
    recorder.writeFooter('pty_exit', 0);
    await closeAndFlush(recorder);

    const records = readLines(findRecordingFile(baseDir, 'signals-only'));
    assert.deepEqual(records.map((r) => r.type), ['header', 'hook', 'decision', 'state', 'footer']);
    assert.equal(records[0].records, 'signals', 'the header declares the verbosity level');
    assert.deepEqual(
      (records[1].payload as Record<string, unknown>).background_tasks,
      [{ id: 't1', type: 'teammate', status: 'running' }],
      'background task state needed for the completion gate remains recorded',
    );
    assert.equal(records[2].action, 'gate-held', 'decisions ride the default signals mode');
    assert.equal((records[3].detail as Record<string, unknown>).deferred, true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('hook recording reduces background tasks and drops the assistant message, keeping every other field', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'projected-hook', baseDir });
    recorder.open();
    recorder.writeHook('Stop', {
      session_id: 'session-1',
      task_id: 'task-1',
      teammate_name: 'researcher',
      tool_input: { file_path: '/tmp/thing.ts' },
      agent_transcript_path: '/tmp/sub.jsonl',
      background_tasks: [{ id: 'task-1', type: 'teammate', status: 'running', transcript: 'large' }],
      backgroundTasks: [{ id: 'task-2', type: 'teammate', status: 'done', transcript: 'large' }],
      last_assistant_message: 'unused response',
      lastAssistantMessage: 'unused grok response',
    });
    await closeAndFlush(recorder);

    const [hook] = readLines(findRecordingFile(baseDir, 'projected-hook'));
    assert.deepEqual(hook.payload, {
      session_id: 'session-1',
      task_id: 'task-1',
      teammate_name: 'researcher',
      tool_input: { file_path: '/tmp/thing.ts' },
      agent_transcript_path: '/tmp/sub.jsonl',
      background_tasks: [{ id: 'task-1', type: 'teammate', status: 'running' }],
      backgroundTasks: [{ id: 'task-2', type: 'teammate', status: 'done' }],
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('a projected recording replays with the same state transitions as its full payload recording', async () => {
  const baseDir = makeBaseDir();
  try {
    const fullPayload = {
      notification_type: 'permission_prompt',
      tool_name: 'Read',
      background_tasks: [{ id: 'task-1', type: 'teammate', status: 'running', detail: 'unread' }],
      last_assistant_message: 'unused response',
      unused: 'unused field',
    };
    const fullRecording = [
      JSON.stringify({ type: 'header', version: 2, agent: 'claude-code' }),
      JSON.stringify({ type: 'hook', ts: 1, event: 'Notification', payload: fullPayload }),
    ].join('\n');
    const expected = await replayDetection(parseRecording(fullRecording).records, {
      stabilizationMs: 1,
      conflictWindowMs: 1,
      dedupWindowMs: 1,
    });
    const recorder = new SessionRecorder({ name: 'projected-replay', baseDir });
    recorder.open();
    recorder.writeHeader({ agent: 'claude-code' });
    recorder.writeHook('Notification', fullPayload);
    await closeAndFlush(recorder);

    const projectedRecording = parseRecording(fs.readFileSync(findRecordingFile(baseDir, 'projected-replay'), 'utf8'));
    const actual = await replayDetection(projectedRecording.records, {
      stabilizationMs: 1,
      conflictWindowMs: 1,
      dedupWindowMs: 1,
      agent: projectedRecording.agent,
    });
    assert.deepEqual(actual.signals.map((signal) => signal.signal), expected.signals.map((signal) => signal.signal));
    assert.deepEqual(projectHookPayload(fullPayload), projectedRecording.records[0]?.payload);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('full mode declares itself in the header', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'full-mode', baseDir, recordData: true });
    recorder.open();
    recorder.writeHeader({ cols: 80, rows: 24 });
    await closeAndFlush(recorder);
    const [header] = readLines(findRecordingFile(baseDir, 'full-mode'));
    assert.equal(header.records, 'full');
    assert.equal(header.version, 2, 'still v2: the replay harness reads the same format');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('a session name with filesystem-illegal characters still records', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'feat/thing: v2', baseDir });
    recorder.open();
    recorder.writeHeader({});
    await closeAndFlush(recorder);
    const entries = fs.readdirSync(baseDir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(entries.length, 1, 'the name is sanitized into a legal filename');
    assert.equal(readLines(path.join(baseDir, entries[0]))[0].session, 'feat/thing: v2', 'header keeps the real name');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('createRecorder records signals by default and only adds PTY bytes when capture is enabled', () => {
  const signals = createRecorder('s1', undefined, true);
  assert.ok(signals instanceof SessionRecorder, 'recording is on by default');
  assert.equal(signals.recordsData, false);
  signals.close();

  const full = createRecorder('s2', { enabled: true }, true);
  assert.equal(full?.recordsData, true);
  full?.close();

  const dataOnlyOptIn = createRecorder('s3', { enabled: true }, false);
  assert.equal(dataOnlyOptIn?.recordsData, true, 'explicit capture opt-in survives the signals kill switch');
  dataOnlyOptIn?.close();
});

test('createRecorder honors a config-provided baseDir', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = createRecorder('configured-dir', { baseDir }, true);
    assert.ok(recorder, 'a configured recorder is created');
    recorder.writeHeader({});
    await closeAndFlush(recorder);
    assert.equal(fs.readdirSync(baseDir).filter((f) => f.endsWith('.jsonl')).length, 1);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('no file is created until the first record is written', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'lazy', baseDir });
    assert.equal(fs.readdirSync(baseDir).length, 0, 'construction writes nothing');
    recorder.writeHook('Stop', { session_id: 'abc' });
    await closeAndFlush(recorder);
    assert.equal(fs.readdirSync(baseDir).filter((f) => f.endsWith('.jsonl')).length, 1);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('createRecorder returns null only when both signals and capture are off', () => {
  assert.equal(createRecorder('s1', { enabled: false }, false), null);
  assert.equal(createRecorder('s1', undefined, false), null);
});

test('a live session records its hook payloads and transitions in signals mode', async (t) => {
  const baseDir = makeBaseDir();

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const recorder = new SessionRecorder({ name: 'live-session', baseDir });
    const s = new Session({ id: 'rec-id', name: 'live-session', path: process.cwd(), statusConflictMs: 5 });
    s.setRecorder(recorder);
    s.state = STATES.RUNNING;
    s.ingestHookSignal({
      signal: 'ready',
      source: 'hook',
      ts: Date.now(),
      event: 'Stop',
      payload: { session_id: 'abcd1234-0000-0000-0000-abcdabcdabcd', background_tasks: [] },
    });
    t.mock.timers.tick(20);
    assert.equal(s.state, STATES.COMPLETE);
    t.mock.timers.reset();
    await closeAndFlush(recorder);
    s.destroy();

    const records = readLines(findRecordingFile(baseDir, 'live-session'));
    const hook = records.find((r) => r.type === 'hook');
    assert.equal(hook?.event, 'Stop');
    assert.equal((hook?.payload as Record<string, unknown>).session_id, 'abcd1234-0000-0000-0000-abcdabcdabcd');
    const state = records.find((r) => r.type === 'state');
    assert.equal(state?.to, STATES.COMPLETE, 'the transition the hook caused is recorded alongside it');
    assert.equal((state?.detail as Record<string, unknown>).signal, 'ready');
    const decision = records.find((r) => r.type === 'decision');
    assert.equal(decision?.kind, 'signal');
    assert.equal(decision?.action, 'transition', 'the decision behind the transition is recorded too');
    assert.equal(decision.active, 0, 'with the evidence it was made on: no background work declared');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('retention prunes recordings older than retainDays', async () => {
  const baseDir = makeBaseDir();
  try {
    const staleFile = path.join(baseDir, 'old-session-2000-01-01T00-00-00-000Z.jsonl');
    fs.writeFileSync(staleFile, '{"type":"header"}\n');
    const staleTime = new Date('2000-01-01T00:00:00.000Z');
    fs.utimesSync(staleFile, staleTime, staleTime);

    const recorder = new SessionRecorder({ name: 'fresh-session', baseDir, retainDays: 7 });
    recorder.open();
    await recorder.retentionDone;
    await closeAndFlush(recorder);

    assert.equal(fs.existsSync(staleFile), false, 'stale recording should be pruned');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('retention keeps only the newest retainFiles recordings of THIS session', async () => {
  const baseDir = makeBaseDir();
  try {
    const older: string[] = [];
    for (const stamp of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      const f = path.join(baseDir, `capped-${stamp}T00-00-00-000Z.jsonl`);
      fs.writeFileSync(f, '{"type":"header"}\n');
      older.push(f);
    }
    const otherSession = path.join(baseDir, 'someone-else-2026-01-01T00-00-00-000Z.jsonl');
    fs.writeFileSync(otherSession, '{"type":"header"}\n');

    const recorder = new SessionRecorder({ name: 'capped', baseDir, retainDays: 0, retainFiles: 2 });
    recorder.open();
    await recorder.retentionDone;
    await closeAndFlush(recorder);

    assert.equal(fs.existsSync(older[0]), false, 'oldest pruned');
    assert.equal(fs.existsSync(older[1]), false, 'second oldest pruned');
    assert.equal(fs.existsSync(older[2]), true, 'newest of the older files kept');
    assert.equal(fs.existsSync(otherSession), true, 'another session file is not counted against this cap');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('retention never prunes the file just opened', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'self', baseDir, retainDays: 0, retainFiles: 1 });
    recorder.open();
    recorder.writeHeader({});
    await recorder.retentionDone;
    await closeAndFlush(recorder);
    assert.equal(fs.readdirSync(baseDir).filter((f) => f.endsWith('.jsonl')).length, 1);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('retention evicts oldest recordings until the directory byte budget fits', async () => {
  const baseDir = makeBaseDir();
  try {
    const old = path.join(baseDir, 'old-2026-01-01T00-00-00-000Z.jsonl');
    const recent = path.join(baseDir, 'recent-2026-01-02T00-00-00-000Z.jsonl');
    fs.writeFileSync(old, 'a'.repeat(80));
    fs.writeFileSync(recent, 'b'.repeat(80));
    fs.utimesSync(old, new Date('2026-01-01'), new Date('2026-01-01'));
    fs.utimesSync(recent, new Date('2026-01-02'), new Date('2026-01-02'));
    const recorder = new SessionRecorder({ name: 'current', baseDir, retainDays: 0, retainFiles: 0, retainBytes: 100 });
    recorder.open();
    await recorder.retentionDone;
    await closeAndFlush(recorder);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(recent), true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

function whenStreamOpen(recorder: SessionRecorder): Promise<void> {
  const stream = recorder._stream;
  if (!stream || !stream.pending) return Promise.resolve();
  return new Promise<void>((resolve) => {
    stream.once('open', () => resolve());
  });
}

test('the byte budget evicts a closed recording but never one another session still has open', async () => {
  const baseDir = makeBaseDir();
  const first = new SessionRecorder({ name: 'first', baseDir, retainDays: 0, retainFiles: 0, retainBytes: 50 });
  const second = new SessionRecorder({ name: 'second', baseDir, retainDays: 0, retainFiles: 0, retainBytes: 50 });
  try {
    const closed = path.join(baseDir, 'closed-2026-01-01T00-00-00-000Z.jsonl');
    fs.writeFileSync(closed, 'a'.repeat(400));
    fs.utimesSync(closed, new Date('2026-01-01'), new Date('2026-01-01'));

    first.open();
    first.writeHeader({});
    await first.retentionDone;
    await whenStreamOpen(first);

    second.open();
    second.writeHeader({});
    await second.retentionDone;
    await whenStreamOpen(second);

    assert.equal(fs.existsSync(closed), false, 'a closed over-budget recording is still evicted');
    assert.equal(fs.existsSync(first._filepath as string), true, 'another live recorder file must survive');
    assert.equal(fs.existsSync(second._filepath as string), true);
  } finally {
    await closeAndFlush(first);
    await closeAndFlush(second);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('retention is skipped entirely when both bounds are disabled', async () => {
  const baseDir = makeBaseDir();
  try {
    const staleFile = path.join(baseDir, 'old-session-2000-01-01T00-00-00-000Z.jsonl');
    fs.writeFileSync(staleFile, '{"type":"header"}\n');
    const staleTime = new Date('2000-01-01T00:00:00.000Z');
    fs.utimesSync(staleFile, staleTime, staleTime);

    const oversizedFile = path.join(baseDir, 'huge-session-2000-01-02T00-00-00-000Z.jsonl');
    fs.writeFileSync(oversizedFile, '');
    fs.truncateSync(oversizedFile, 128 * 1024 * 1024);
    fs.utimesSync(oversizedFile, staleTime, staleTime);

    const recorder = new SessionRecorder({ name: 'no-retention', baseDir, retainDays: 0, retainFiles: 0 });
    recorder.open();
    await recorder.retentionDone;
    await closeAndFlush(recorder);

    assert.equal(fs.existsSync(staleFile), true, 'both bounds off must keep everything');
    assert.equal(fs.existsSync(oversizedFile), true, 'both bounds off leaves no implicit byte budget to evict against');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('the default byte budget still applies when only one of the other bounds is disabled', async () => {
  const baseDir = makeBaseDir();
  try {
    const oversizedFile = path.join(baseDir, 'huge-session-2000-01-02T00-00-00-000Z.jsonl');
    fs.writeFileSync(oversizedFile, '');
    fs.truncateSync(oversizedFile, 128 * 1024 * 1024);
    const staleTime = new Date('2000-01-02T00:00:00.000Z');
    fs.utimesSync(oversizedFile, staleTime, staleTime);

    const recorder = new SessionRecorder({ name: 'byte-default', baseDir, retainDays: 0, retainFiles: 20 });
    recorder.open();
    await recorder.retentionDone;
    await closeAndFlush(recorder);

    assert.equal(fs.existsSync(oversizedFile), false, 'an unbounded directory is still capped by the default budget');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('two recorders cleaning up back to back stop at the byte budget instead of emptying the directory', async () => {
  const baseDir = makeBaseDir();
  const first = new SessionRecorder({ name: 'first', baseDir, retainDays: 0, retainFiles: 0, retainBytes: 64 });
  const second = new SessionRecorder({ name: 'second', baseDir, retainDays: 0, retainFiles: 0, retainBytes: 64 });
  try {
    const prior = ['01', '02', '03', '04', '05'].map((day) => {
      const filepath = path.join(baseDir, `prior-2026-01-${day}T00-00-00-000Z.jsonl`);
      fs.writeFileSync(filepath, 'a'.repeat(40));
      const stamp = new Date(`2026-01-${day}T00:00:00.000Z`);
      fs.utimesSync(filepath, stamp, stamp);
      return filepath;
    });

    first.open();
    second.open();
    await first.retentionDone;
    await second.retentionDone;

    assert.equal(fs.existsSync(prior[4]), true, 'the newest prior recording fits the budget and must survive both passes');
    assert.equal(fs.existsSync(prior[3]), false, 'the over-budget older recordings are still evicted');
  } finally {
    await closeAndFlush(first);
    await closeAndFlush(second);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
