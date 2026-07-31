'use strict';

// Round-trip tests for session-recorder.js: write every record kind through
// SessionRecorder, then read the JSONL file back and assert fidelity
// (ordering, timestamp shape, payload contents).
//
// Recording is on by default in SIGNALS mode (hooks + state transitions, the forensic minimum);
// raw PTY bytes are opt-in. See AGENTS.md, "Session Recording".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionRecorder, createRecorder } = require('../session/session-recorder');
const { Session } = require('../session/sessions');
const { STATES } = require('../shared/states');

function makeBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-recorder-'));
}

function readLines(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

function findRecordingFile(baseDir, name) {
  const entries = fs.readdirSync(baseDir).filter((f) => f.startsWith(`${name}-`) && f.endsWith('.jsonl'));
  assert.equal(entries.length, 1, 'exactly one recording file expected');
  return path.join(baseDir, entries[0]);
}

// SessionRecorder.close() calls stream.end() and immediately nulls the
// stream reference; the underlying fs.WriteStream flush is asynchronous, so
// a synchronous readdir/readFile right after close() races the actual
// write. Capture the stream before closing and await its 'finish' event
// (or resolve immediately when there is no stream, e.g. close-before-open).
function closeAndFlush(recorder) {
  const stream = recorder._stream;
  if (!stream) {
    recorder.close();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    stream.once('finish', resolve);
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
    recorder.writeInput('ls -la\n');
    recorder.writeResize(120, 40);
    recorder.writeFooter('exit', 0);
    await closeAndFlush(recorder);

    const filepath = findRecordingFile(baseDir, 'roundtrip-session');
    const records = readLines(filepath);

    assert.equal(records.length, 7);
    assert.deepEqual(
      records.map((r) => r.type),
      ['header', 'data', 'hook', 'state', 'input', 'resize', 'footer'],
    );

    const [header, data, hook, state, input, resize, footer] = records;

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
    recorder.writeHook('SessionEnd');
    recorder.writeFooter('kill');
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
      assert.ok(records[i].ts >= records[i - 1].ts, 'timestamps must not decrease');
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
    recorder2.close(); // second close must not throw

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

// Signals mode: the default. The forensic records a detection post-mortem needs are kept; the
// bulky ones are not written at all.
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
    recorder.writeState('RUNNING', 'COMPLETE', 'task_complete', { source: 'hook', signal: 'ready', deferred: true });
    recorder.writeFooter('pty_exit', 0);
    await closeAndFlush(recorder);

    const records = readLines(findRecordingFile(baseDir, 'signals-only'));
    assert.deepEqual(records.map((r) => r.type), ['header', 'hook', 'state', 'footer']);
    assert.equal(records[0].records, 'signals', 'the header declares the verbosity level');
    assert.deepEqual(
      records[1].payload.background_tasks,
      [{ id: 't1', type: 'teammate', status: 'running' }],
      'hook payloads are recorded verbatim: that is the whole point',
    );
    assert.equal(records[2].detail.deferred, true);
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
  assert.equal(full.recordsData, true);
  full.close();

  const dataOnlyOptIn = createRecorder('s3', { enabled: true }, false);
  assert.equal(dataOnlyOptIn.recordsData, true, 'explicit capture opt-in survives the signals kill switch');
  dataOnlyOptIn.close();
});

// A constructed-but-never-started session (DORMANT at boot) must not touch the disk at all.
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

// The forensic guarantee, end to end at the Session seam: the records that a detection
// post-mortem reads (verbatim hook payloads + the transitions they caused) reach the file
// without any capture opt-in.
test('a live session records its hook payloads and transitions in signals mode', async (t) => {
  const baseDir = makeBaseDir();
  // Mocked timers keep this at the detection seam: real ones would also let the debounced
  // post-turn worktree check fire against this repo.
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
    t.mock.timers.tick(20); // past the conflict window: the ready resolves and transitions
    assert.equal(s.state, STATES.COMPLETE);
    t.mock.timers.reset(); // the stream flush below needs real async
    await closeAndFlush(recorder);
    s.destroy();

    const records = readLines(findRecordingFile(baseDir, 'live-session'));
    const hook = records.find((r) => r.type === 'hook');
    assert.equal(hook.event, 'Stop');
    assert.equal(hook.payload.session_id, 'abcd1234-0000-0000-0000-abcdabcdabcd');
    const state = records.find((r) => r.type === 'state');
    assert.equal(state.to, STATES.COMPLETE, 'the transition the hook caused is recorded alongside it');
    assert.equal(state.detail.signal, 'ready');
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
    const older = [];
    for (const stamp of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      const f = path.join(baseDir, `capped-${stamp}T00-00-00-000Z.jsonl`);
      fs.writeFileSync(f, '{"type":"header"}\n');
      older.push(f);
    }
    const otherSession = path.join(baseDir, 'someone-else-2026-01-01T00-00-00-000Z.jsonl');
    fs.writeFileSync(otherSession, '{"type":"header"}\n');

    const recorder = new SessionRecorder({ name: 'capped', baseDir, retainDays: 0, retainFiles: 2 });
    recorder.open(); // this is now the newest file, so 2 of the 3 older ones must go
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

test('retention is skipped entirely when both bounds are disabled', async () => {
  const baseDir = makeBaseDir();
  try {
    const staleFile = path.join(baseDir, 'old-session-2000-01-01T00-00-00-000Z.jsonl');
    fs.writeFileSync(staleFile, '{"type":"header"}\n');
    const staleTime = new Date('2000-01-01T00:00:00.000Z');
    fs.utimesSync(staleFile, staleTime, staleTime);

    const recorder = new SessionRecorder({ name: 'no-retention', baseDir, retainDays: 0, retainFiles: 0 });
    recorder.open();
    await recorder.retentionDone;
    await closeAndFlush(recorder);

    assert.equal(fs.existsSync(staleFile), true, 'both bounds off must keep everything');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
