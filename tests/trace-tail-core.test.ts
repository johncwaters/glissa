import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  MAX_REMEMBERED_TRANSCRIPTS,
  MAX_TRANSCRIPT_READ_BYTES,
  TRACE_TAIL_SCAN_BYTES,
  committedOffsetFromTraceTailOrNull,
  completeLineBytes,
  containmentRefusalReason,
  isOversizedPartialLine,
  isPathInsideRoot,
  planContiguousRead,
  resumeOffsetFrom,
  withCommittedOffset,
} from '../server/core/trace-tail-core.ts';

test('the trace tail window contains a maximum-size call record plus its run marker', () => {
  assert.ok(TRACE_TAIL_SCAN_BYTES > 130_000);
  const transcriptPath = '/projects/a/session.jsonl';
  const trace = [
    JSON.stringify({ kind: 'session', transcriptPath }),
    JSON.stringify({ kind: 'prompt', transcriptOffset: 700 }),
    JSON.stringify({ kind: 'tool_call', input: 'x'.repeat(130_000) }),
    '',
  ].join('\n');
  const tail = Buffer.from(trace).subarray(-TRACE_TAIL_SCAN_BYTES).toString('utf8');
  assert.equal(committedOffsetFromTraceTailOrNull(tail, {
    transcriptPath,
    isWholeFile: Buffer.byteLength(trace) <= TRACE_TAIL_SCAN_BYTES,
  }), 700);
});

test('containment classifies missing path errors apart from unreadable errors', () => {
  assert.equal(containmentRefusalReason({ code: 'ENOENT' }), 'missing');
  assert.equal(containmentRefusalReason({ code: 'ENOTDIR' }), 'missing');
  assert.equal(containmentRefusalReason({ code: 'EACCES' }), 'unreadable');
});

test('a contiguous plan reads forward from the committed offset and defers the overflow', () => {
  assert.deepEqual(planContiguousRead({ offset: 10 }, { size: 40 }, { maxReadBytes: 8 }), {
    action: 'read', start: 10, end: 18, reset: false,
  });
  assert.deepEqual(planContiguousRead({ offset: 10 }, { size: 14 }, { maxReadBytes: 8 }), {
    action: 'read', start: 10, end: 14, reset: false,
  });
  assert.deepEqual(planContiguousRead({ offset: 40 }, { size: 40 }, { maxReadBytes: 8 }), {
    action: 'skip', start: 40, end: 40, reset: false,
  });
  assert.deepEqual(planContiguousRead({ offset: 0 }, { size: 3 * MAX_TRANSCRIPT_READ_BYTES }).end, MAX_TRANSCRIPT_READ_BYTES);
});

test('a transcript shorter than the committed offset plans a reset from zero', () => {
  assert.deepEqual(planContiguousRead({ offset: 90 }, { size: 12 }, { maxReadBytes: 64 }), {
    action: 'read', start: 0, end: 12, reset: true,
  });
  assert.deepEqual(planContiguousRead({ offset: 90 }, { size: 0 }, { maxReadBytes: 64 }), {
    action: 'skip', start: 0, end: 0, reset: true,
  });
});

test('an unusable stat leaves the offset where it is', () => {
  assert.deepEqual(planContiguousRead({ offset: 7 }, null), {
    action: 'skip', start: 7, end: 7, reset: false,
  });
  assert.deepEqual(planContiguousRead(null, { size: 40 }), {
    action: 'skip', start: 0, end: 0, reset: false,
  });
});

test('the complete-line boundary is the byte after the last break', () => {
  assert.equal(completeLineBytes(Buffer.from('one\ntwo\nhalf')), 8);
  assert.equal(completeLineBytes(Buffer.from('no break at all')), 0);
  assert.equal(completeLineBytes(Buffer.alloc(0)), 0);
  assert.equal(completeLineBytes(Buffer.from('only\n', 'utf8')), 5);
});

test('a checkpoint resumes only for its own transcript and resets when the file shrank', () => {
  const checkpoint = { transcriptPath: '/projects/a/session.jsonl', offset: 500 };
  assert.deepEqual(resumeOffsetFrom(checkpoint, { transcriptPath: '/projects/a/session.jsonl', size: 900 }), {
    offset: 500, didReset: false, didFallbackToTranscriptEnd: false,
  });
  assert.deepEqual(resumeOffsetFrom(checkpoint, { transcriptPath: '/projects/a/session.jsonl', size: 120 }), {
    offset: 0, didReset: true, didFallbackToTranscriptEnd: false,
  });
  assert.deepEqual(resumeOffsetFrom(checkpoint, { transcriptPath: '/projects/a/other.jsonl', size: 900 }), {
    offset: 0, didReset: false, didFallbackToTranscriptEnd: false,
  });
  assert.deepEqual(resumeOffsetFrom(null, { transcriptPath: '/projects/a/session.jsonl', size: 900 }), {
    offset: 0, didReset: false, didFallbackToTranscriptEnd: false,
  });
});

test('containment refuses a sibling, the root itself and a parent traversal', () => {
  const root = path.join(path.sep, 'projects');
  assert.equal(isPathInsideRoot(root, path.join(root, 'a', 'session.jsonl')), true);
  assert.equal(isPathInsideRoot(root, root), false);
  assert.equal(isPathInsideRoot(root, path.join(path.sep, 'projects-elsewhere', 'session.jsonl')), false);
  assert.equal(isPathInsideRoot(root, path.join(root, '..', 'session.jsonl')), false);
});

test('a partial line is oversized only past the byte bound', () => {
  assert.equal(isOversizedPartialLine('x'.repeat(8), { maxPartialLineBytes: 8 }), false);
  assert.equal(isOversizedPartialLine('x'.repeat(9), { maxPartialLineBytes: 8 }), true);
});

test('a partial line held as raw bytes is measured by its byte length', () => {
  assert.equal(isOversizedPartialLine(Buffer.alloc(8), { maxPartialLineBytes: 8 }), false);
  assert.equal(isOversizedPartialLine(Buffer.alloc(9), { maxPartialLineBytes: 8 }), true);
  assert.equal(isOversizedPartialLine(Buffer.from('x'.repeat(9), 'utf8'), { maxPartialLineBytes: 8 }), true);
});

test('a checkpoint resumes a transcript it traced before returning to the newest one', () => {
  const checkpoint = {
    transcriptPath: '/projects/a/second.jsonl',
    offset: 120,
    offsetByTranscriptPath: { '/projects/a/first.jsonl': 900, '/projects/a/second.jsonl': 120 },
  };

  assert.deepEqual(resumeOffsetFrom(checkpoint, { transcriptPath: '/projects/a/first.jsonl', size: 1200 }), {
    offset: 900, didReset: false, didFallbackToTranscriptEnd: false,
  });
  assert.deepEqual(resumeOffsetFrom(checkpoint, { transcriptPath: '/projects/a/first.jsonl', size: 400 }), {
    offset: 0, didReset: true, didFallbackToTranscriptEnd: false,
  });
});

test('a batch appended past the checkpoint moves the resume point forward', () => {
  const checkpoint = { transcriptPath: '/projects/a/session.jsonl', offset: 500 };

  assert.deepEqual(
    resumeOffsetFrom(checkpoint, { transcriptPath: '/projects/a/session.jsonl', size: 4000, alreadyTracedOffset: 3000 }),
    { offset: 3000, didReset: false, didFallbackToTranscriptEnd: false },
  );
  assert.deepEqual(
    resumeOffsetFrom(checkpoint, { transcriptPath: '/projects/a/session.jsonl', size: 4000, alreadyTracedOffset: 120 }),
    { offset: 500, didReset: false, didFallbackToTranscriptEnd: false },
  );
});

test('a lost checkpoint whose run the trace tail cannot establish resumes at the transcript end', () => {
  assert.deepEqual(
    resumeOffsetFrom(null, {
      transcriptPath: '/projects/a/session.jsonl',
      size: 900,
      alreadyTracedOffset: null,
      traceSize: 64 * 1024,
    }),
    { offset: 900, didReset: false, didFallbackToTranscriptEnd: true },
  );
  assert.deepEqual(
    resumeOffsetFrom(null, {
      transcriptPath: '/projects/a/session.jsonl',
      size: 900,
      alreadyTracedOffset: null,
      traceSize: 0,
    }),
    { offset: 0, didReset: false, didFallbackToTranscriptEnd: false },
  );
  assert.deepEqual(
    resumeOffsetFrom({ transcriptPath: '/projects/a/session.jsonl', offset: 500 }, {
      transcriptPath: '/projects/a/session.jsonl',
      size: 900,
      alreadyTracedOffset: null,
      traceSize: 64 * 1024,
    }),
    { offset: 500, didReset: false, didFallbackToTranscriptEnd: false },
  );
});

test('the trace tail reports the offset appended for the transcript being bound', () => {
  const tail = [
    JSON.stringify({ kind: 'session', transcriptPath: '/projects/a/first.jsonl' }),
    JSON.stringify({ kind: 'prompt', transcriptOffset: 400 }),
    JSON.stringify({ kind: 'session', transcriptPath: '/projects/a/second.jsonl' }),
    JSON.stringify({ kind: 'prompt', transcriptOffset: 90 }),
    '',
  ].join('\n');

  assert.equal(committedOffsetFromTraceTailOrNull(tail, { transcriptPath: '/projects/a/first.jsonl', isWholeFile: true }), 400);
  assert.equal(committedOffsetFromTraceTailOrNull(tail, { transcriptPath: '/projects/a/second.jsonl', isWholeFile: true }), 90);
  assert.equal(committedOffsetFromTraceTailOrNull(tail, { transcriptPath: '/projects/a/third.jsonl', isWholeFile: true }), null);
});

test('a run marked with no records of its own resumes at zero, not as an unknown run', () => {
  const tail = [
    JSON.stringify({ kind: 'session', transcriptPath: '/projects/a/first.jsonl' }),
    JSON.stringify({ kind: 'session', transcriptPath: '/projects/a/second.jsonl' }),
    JSON.stringify({ kind: 'prompt', transcriptOffset: 90 }),
  ].join('\n');

  assert.equal(committedOffsetFromTraceTailOrNull(tail, { transcriptPath: '/projects/a/first.jsonl', isWholeFile: true }), 0);
  assert.equal(committedOffsetFromTraceTailOrNull(tail, { transcriptPath: '/projects/a/second.jsonl', isWholeFile: true }), 90);
  assert.equal(committedOffsetFromTraceTailOrNull(tail, { transcriptPath: '/projects/a/third.jsonl', isWholeFile: true }), null);
});

test('a window opening mid-file drops its partial line and trusts the path only from the checkpoint', () => {
  const tail = ['e": 12}', JSON.stringify({ kind: 'prompt', transcriptOffset: 700 })].join('\n');

  assert.equal(
    committedOffsetFromTraceTailOrNull(tail, {
      transcriptPath: '/projects/a/session.jsonl',
      pathBeforeWindow: '/projects/a/session.jsonl',
    }),
    700,
  );
  assert.equal(committedOffsetFromTraceTailOrNull(tail, { transcriptPath: '/projects/a/session.jsonl' }), null);
  assert.equal(
    committedOffsetFromTraceTailOrNull(tail, {
      transcriptPath: '/projects/a/session.jsonl',
      pathBeforeWindow: '/projects/a/other.jsonl',
    }),
    null,
  );
});

test('a record before the first session record of the window is never attributed', () => {
  const tail = [
    JSON.stringify({ kind: 'prompt', transcriptOffset: 5000 }),
    JSON.stringify({ kind: 'session', transcriptPath: '/projects/a/second.jsonl' }),
    JSON.stringify({ kind: 'prompt', transcriptOffset: 30 }),
  ].join('\n');

  assert.equal(
    committedOffsetFromTraceTailOrNull(tail, {
      transcriptPath: '/projects/a/second.jsonl',
      pathBeforeWindow: '/projects/a/second.jsonl',
      isWholeFile: true,
    }),
    30,
  );
});

test('remembered offsets keep the newest transcripts and refresh a path in place', () => {
  const afterFirst = withCommittedOffset({}, '/projects/a/first.jsonl', 100);
  const afterSecond = withCommittedOffset(afterFirst, '/projects/a/second.jsonl', 200);
  const afterReturn = withCommittedOffset(afterSecond, '/projects/a/first.jsonl', 350);

  assert.deepEqual(afterReturn, { '/projects/a/second.jsonl': 200, '/projects/a/first.jsonl': 350 });
  assert.deepEqual(Object.keys(afterReturn), ['/projects/a/second.jsonl', '/projects/a/first.jsonl']);

  let bounded: Record<string, number> = {};
  for (let index = 0; index < MAX_REMEMBERED_TRANSCRIPTS + 4; index += 1) {
    bounded = withCommittedOffset(bounded, `/projects/a/${index}.jsonl`, index);
  }

  assert.equal(Object.keys(bounded).length, MAX_REMEMBERED_TRANSCRIPTS);
  assert.equal(bounded['/projects/a/3.jsonl'], undefined);
  assert.equal(bounded['/projects/a/4.jsonl'], 4);
});

test('remembered offsets evict the oldest path at a custom cap', () => {
  let bounded: Record<string, number> = {};
  for (let index = 0; index < 4; index += 1) {
    bounded = withCommittedOffset(bounded, `/projects/a/${index}.jsonl`, index, { maxRemembered: 2 });
  }

  assert.deepEqual(bounded, {
    '/projects/a/2.jsonl': 2,
    '/projects/a/3.jsonl': 3,
  });
});
