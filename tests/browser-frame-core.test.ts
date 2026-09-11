import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEAR_ALL,
  bodyRows,
  expectedRows,
  paintFull,
  parseStatusRow,
  repaintInPlace,
  rulerFill,
  statusRow,
} from '../test/browser/frame-core.ts';

const WIDTHS = [1, 2, 13, 80, 200, 500];
const HEIGHTS = [1, 2, 24, 60];

test('every painted row is exactly as wide as the screen', () => {
  for (const cols of WIDTHS) {
    for (const rows of HEIGHTS) {
      for (const row of expectedRows(cols, rows, 7)) {
        assert.equal(row.length, cols, `cols=${cols} rows=${rows} painted a row of ${row.length}`);
      }
    }
  }
});

test('a screen holds exactly one row per terminal line', () => {
  for (const cols of WIDTHS) {
    for (const rows of HEIGHTS) {
      assert.equal(expectedRows(cols, rows, 0).length, rows);
      assert.equal(bodyRows(cols, rows).length, rows - 1);
    }
  }
});

test('no painted row ends in whitespace', () => {
  for (const cols of WIDTHS) {
    for (const rows of HEIGHTS) {
      for (const tick of [0, 1, 999]) {
        for (const row of expectedRows(cols, rows, tick)) {
          assert.equal(/\s$/.test(row), false, `cols=${cols} rows=${rows} tick=${tick} row "${row}" ends in whitespace`);
        }
      }
    }
  }
});

test('a fill shorter than the prefix keeps the prefix and the width', () => {
  assert.equal(rulerFill('0|', 1), '0');
  assert.equal(rulerFill('0|', 2), '0|');
  assert.equal(rulerFill('0|', 6), '0|0123');
  assert.equal(rulerFill('a ', 2).endsWith(' '), false);
});

test('a status row round trips through the parser', () => {
  for (const [cols, rows, tick] of [[80, 24, 0], [120, 40, 3], [500, 60, 4096]]) {
    assert.deepEqual(parseStatusRow(statusRow(cols, rows, tick)), { cols, rows, tick });
  }
});

test('the parser refuses a row that carries no status fields', () => {
  assert.equal(parseStatusRow(''), null);
  assert.equal(parseStatusRow(rulerFill('0|', 80)), null);
  assert.equal(parseStatusRow('cols=80 rows=24'), null);
});

test('distinct ticks paint distinct status rows', () => {
  const first = statusRow(80, 24, 0);
  const second = statusRow(80, 24, 1);
  assert.notEqual(first, second);
  assert.equal(statusRow(80, 24, 0), first);
});

test('a resize alone repaints the same tick', () => {
  assert.deepEqual(parseStatusRow(statusRow(60, 8, 2)), { cols: 60, rows: 8, tick: 2 });
  assert.notEqual(statusRow(60, 8, 2), statusRow(40, 10, 2));
});

test('a full paint clears the screen and never trails a newline', () => {
  const painted = paintFull(40, 10, 0);
  assert.equal(painted.startsWith(CLEAR_ALL), true);
  assert.equal(painted.includes('\n'), true);
  assert.equal(painted.endsWith(expectedRows(40, 10, 0)[9] ?? ''), true);
  assert.equal(painted.split('\r\n').length, 10);
});

test('an in place repaint walks back over every row it painted', () => {
  const escapeChar = String.fromCharCode(0x1b);
  const painted = repaintInPlace(40, 10, 3);
  assert.equal(painted.startsWith(`${escapeChar}[9A\r${escapeChar}[2K`), true);
  assert.equal(painted.split('\r\n').length, 10);
  assert.equal(painted.endsWith(statusRow(40, 10, 3)), true);
});

test('a single row screen repaints without a cursor move', () => {
  const painted = repaintInPlace(40, 1, 1);
  assert.equal(painted.startsWith(`\r${String.fromCharCode(0x1b)}[2K`), true);
  assert.equal(painted.includes('\r\n'), false);
});
