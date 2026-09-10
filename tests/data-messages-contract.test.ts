import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DataClientMessage,
  PtySizeFrame,
  VIEWER_MAX_COLS,
  VIEWER_MAX_ROWS,
  VIEWER_MIN_COLS,
  VIEWER_MIN_ROWS,
  parseDataClientMessage,
  parsePtySizeFrame,
} from '../shared/contracts/data-messages.ts';
import { isApplicableViewerSize } from '../server/core/viewer-size-core.ts';

test('the claim bounds are one definition, shared with the size core', () => {
  assert.equal(isApplicableViewerSize(VIEWER_MIN_COLS, VIEWER_MIN_ROWS), true);
  assert.equal(isApplicableViewerSize(VIEWER_MAX_COLS, VIEWER_MAX_ROWS), true);
  assert.equal(isApplicableViewerSize(VIEWER_MAX_COLS + 1, VIEWER_MAX_ROWS), false);
  assert.equal(isApplicableViewerSize(VIEWER_MAX_COLS, VIEWER_MAX_ROWS + 1), false);
  assert.equal(DataClientMessage.safeParse({ type: 'claim', cols: VIEWER_MAX_COLS, rows: VIEWER_MAX_ROWS }).success, true);
  assert.equal(DataClientMessage.safeParse({ type: 'claim', cols: VIEWER_MAX_COLS + 1, rows: 24 }).success, false);
  assert.equal(DataClientMessage.safeParse({ type: 'claim', cols: 80, rows: VIEWER_MAX_ROWS + 1 }).success, false);
});

test('a claim outside the bounds or off the integer grid fails closed', () => {
  for (const claim of [
    { type: 'claim', cols: 0, rows: 24 },
    { type: 'claim', cols: 80, rows: 0 },
    { type: 'claim', cols: 80.5, rows: 24 },
    { type: 'claim', cols: Number.NaN, rows: 24 },
    { type: 'claim', cols: '80', rows: '24' },
    { type: 'claim', rows: 24 },
  ]) {
    assert.equal(DataClientMessage.safeParse(claim).success, false, JSON.stringify(claim));
  }
});

test('input carries no length cap, so the operator-facing paste error still speaks', () => {
  const parsed = DataClientMessage.safeParse({ type: 'input', data: 'x'.repeat(65536) });
  assert.equal(parsed.success, true);
});

test('an unknown type, a missing type and a non-object all fail closed', () => {
  assert.equal(DataClientMessage.safeParse({ type: 'resize', cols: 80, rows: 24 }).success, false);
  assert.equal(DataClientMessage.safeParse({ cols: 80, rows: 24 }).success, false);
  assert.equal(DataClientMessage.safeParse('input').success, false);
  assert.equal(DataClientMessage.safeParse(null).success, false);
  assert.equal(DataClientMessage.safeParse([{ type: 'unview' }]).success, false);
});

test('parseDataClientMessage answers null for malformed JSON instead of throwing', () => {
  assert.equal(parseDataClientMessage('{ not json'), null);
  assert.equal(parseDataClientMessage(''), null);
  assert.equal(parseDataClientMessage('{"type":"resize","cols":80,"rows":24}'), null);
  assert.deepEqual(parseDataClientMessage('{"type":"unview"}'), { type: 'unview' });
  assert.deepEqual(parseDataClientMessage('{"type":"claim","cols":80,"rows":24}'), { type: 'claim', cols: 80, rows: 24 });
});

test('the pty-size frame is the only structured server-to-client shape', () => {
  assert.equal(PtySizeFrame.safeParse({ type: 'pty-size', cols: 80, rows: 24, seq: 0 }).success, true);
  assert.equal(PtySizeFrame.safeParse({ type: 'pty-size', cols: 80, rows: 24, seq: -1 }).success, false);
  assert.equal(PtySizeFrame.safeParse({ type: 'pty-size', cols: 80, rows: 24 }).success, false);
  assert.equal(PtySizeFrame.safeParse({ type: 'size', cols: 80, rows: 24, seq: 1 }).success, false);
});

test('parsePtySizeFrame decodes both directions of the wire contract the same way', () => {
  assert.equal(parsePtySizeFrame('{ not json'), null);
  assert.equal(parsePtySizeFrame(''), null);
  assert.equal(parsePtySizeFrame('{"type":"pty-size","cols":80,"rows":24}'), null);
  assert.equal(parsePtySizeFrame(`{"type":"pty-size","cols":${VIEWER_MAX_COLS + 1},"rows":24,"seq":1}`), null);
  assert.deepEqual(
    parsePtySizeFrame('{"type":"pty-size","cols":80,"rows":24,"seq":3}'),
    { type: 'pty-size', cols: 80, rows: 24, seq: 3 },
  );
});
