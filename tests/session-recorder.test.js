'use strict';

// Round-trip tests for session-recorder.js: write every record kind through
// SessionRecorder, then read the JSONL file back and assert fidelity
// (ordering, timestamp shape, payload contents).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionRecorder, createRecorder } = require('../session/session-recorder');

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
    const recorder = new SessionRecorder({ name: 'roundtrip-session', baseDir });
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
    const recorder = new SessionRecorder({ name: 'default-dims', baseDir });
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
    const recorder = new SessionRecorder({ name: 'nullable-fields', baseDir });
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
    const recorder = new SessionRecorder({ name: 'ts-order', baseDir });
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
    const recorder = new SessionRecorder({ name: 'idempotent-close', baseDir });
    recorder.close();
    recorder.close();

    const recorder2 = new SessionRecorder({ name: 'idempotent-close-2', baseDir });
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
    const recorder = new SessionRecorder({ name: 'post-close-write', baseDir });
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

test('createRecorder returns null when capture config is disabled or absent', () => {
  assert.equal(createRecorder('s1', { enabled: false }), null);
  assert.equal(createRecorder('s1', undefined), null);
});

test('createRecorder returns an opened recorder that round-trips a write when enabled', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-recorder-cwd-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(baseDir);
    const recorder = createRecorder('created-session', { enabled: true, retainDays: 0 });
    assert.ok(recorder instanceof SessionRecorder);
    recorder.writeData('via-createRecorder');
    await closeAndFlush(recorder);

    const captureDir = path.join(baseDir, '.pty-capture');
    const filepath = findRecordingFile(captureDir, 'created-session');
    const records = readLines(filepath);
    assert.equal(records.length, 1);
    assert.equal(records[0].data, 'via-createRecorder');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('retention cleanup deletes recordings older than retainDays on open', async () => {
  const baseDir = makeBaseDir();
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    const staleFile = path.join(baseDir, 'old-session-2000-01-01T00-00-00-000Z.jsonl');
    fs.writeFileSync(staleFile, '{"type":"header"}\n');
    const staleTime = new Date('2000-01-01T00:00:00.000Z');
    fs.utimesSync(staleFile, staleTime, staleTime);

    const recorder = new SessionRecorder({ name: 'fresh-session', baseDir, retainDays: 7 });
    recorder.open();
    await closeAndFlush(recorder);

    assert.equal(fs.existsSync(staleFile), false, 'stale recording should be pruned');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('retention cleanup is skipped when retainDays is 0 (recordings kept indefinitely)', async () => {
  const baseDir = makeBaseDir();
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    const staleFile = path.join(baseDir, 'old-session-2000-01-01T00-00-00-000Z.jsonl');
    fs.writeFileSync(staleFile, '{"type":"header"}\n');
    const staleTime = new Date('2000-01-01T00:00:00.000Z');
    fs.utimesSync(staleFile, staleTime, staleTime);

    const recorder = new SessionRecorder({ name: 'no-retention', baseDir, retainDays: 0 });
    recorder.open();
    await closeAndFlush(recorder);

    assert.equal(fs.existsSync(staleFile), true, 'retainDays<=0 must skip cleanup');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
