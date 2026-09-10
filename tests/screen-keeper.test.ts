import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

import { SCREEN_RESET, SCREEN_KEEPER_SCROLLBACK } from '../session/core/screen-keeper-core.ts';
import { createScreenKeeper } from '../session/screen-keeper.ts';

const { Terminal } = headless;

const START_COLS = 80;
const START_ROWS = 12;
const FINAL_COLS = 46;

type Cell = [string, number, number, number, boolean, boolean, boolean];

function newTerminal(cols: number, rows: number): HeadlessTerminal {
  return new Terminal({ cols, rows, scrollback: SCREEN_KEEPER_SCROLLBACK, allowProposedApi: true });
}

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => { terminal.write(data, () => resolve()); });
}

function dump(terminal: HeadlessTerminal): Cell[][] {
  const buffer = terminal.buffer.active;
  const rows: Cell[][] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    const cells: Cell[] = [];
    if (line) {
      for (let x = 0; x < terminal.cols; x += 1) {
        const cell = line.getCell(x);
        if (!cell) continue;
        cells.push([
          cell.getChars(),
          cell.getWidth(),
          cell.getFgColor(),
          cell.getBgColor(),
          cell.isBold() !== 0,
          cell.isInverse() !== 0,
          cell.isUnderline() !== 0,
        ]);
      }
    }
    rows.push(cells);
  }
  return rows;
}

const BEFORE_RESIZE = [
  '\x1b[1;31mred bold header\x1b[0m\r\n',
  '\x1b[4munderlined\x1b[24m plain \x1b[7minverse\x1b[27m\r\n',
  'wide: 世界你好 ok\r\n',
  '\x1b[?1049h',
  '\x1b[2J\x1b[H\x1b[32malt buffer screen\x1b[0m\r\n',
  '\x1b[5;20Hcursor addressed in alt\r\n',
  '\x1b[?1049l',
  'back on the normal buffer\r\n',
  ...Array.from({ length: 40 }, (_unused, index) => `scrollback line ${index} \x1b[3${index % 8}mtinted\x1b[0m\r\n`),
  '\x1b[8;10Hcursor addressed on normal\r\n',
];

const AFTER_RESIZE = [
  '\x1b[36mafter the resize\x1b[0m\r\n',
  'wide again: 日本語\r\n',
  '\x1b[2;5Hre-addressed at the new width',
];

async function keeperParsedAll(keeper: { parsedOffset(): number }, expected: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (keeper.parsedOffset() < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(keeper.parsedOffset(), expected, 'the keeper parsed every pushed byte');
}

async function buildReference(): Promise<HeadlessTerminal> {
  const terminal = newTerminal(START_COLS, START_ROWS);
  for (const chunk of BEFORE_RESIZE) await write(terminal, chunk);
  terminal.resize(FINAL_COLS, START_ROWS);
  for (const chunk of AFTER_RESIZE) await write(terminal, chunk);
  return terminal;
}

test('a snapshot replayed into a fresh terminal equals the stream it was taken from, cell for cell', async () => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  let pushed = 0;
  for (const chunk of BEFORE_RESIZE) {
    keeper.push(chunk);
    pushed += chunk.length;
  }
  keeper.resize(FINAL_COLS, START_ROWS);
  for (const chunk of AFTER_RESIZE) {
    keeper.push(chunk);
    pushed += chunk.length;
  }
  await keeperParsedAll(keeper, pushed);

  const reference = await buildReference();
  const snapshot = SCREEN_RESET + keeper.serialize();
  const replay = newTerminal(FINAL_COLS, START_ROWS);
  await write(replay, snapshot);

  assert.deepEqual(dump(replay), dump(reference), 'the replayed screen is the live screen');
  assert.equal(replay.buffer.active.cursorX, reference.buffer.active.cursorX);
  assert.equal(replay.buffer.active.cursorY, reference.buffer.active.cursorY);

  keeper.dispose();
  reference.dispose();
  replay.dispose();
});

test('a resize is applied only once the bytes before it have parsed', async () => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  const wideRun = `${'x'.repeat(200)}\r\n`;
  keeper.push(wideRun);
  keeper.resize(FINAL_COLS, START_ROWS);
  assert.equal(keeper.parsedOffset(), 0, 'the resize was queued behind bytes that have not parsed yet');
  await keeperParsedAll(keeper, wideRun.length);

  const reference = newTerminal(START_COLS, START_ROWS);
  await write(reference, wideRun);
  reference.resize(FINAL_COLS, START_ROWS);

  const replay = newTerminal(FINAL_COLS, START_ROWS);
  await write(replay, SCREEN_RESET + keeper.serialize());
  assert.deepEqual(dump(replay), dump(reference), 'the 200-column run wrapped at 80, not at 46');

  keeper.dispose();
  reference.dispose();
  replay.dispose();
});

test('serializing a replayed snapshot is a fixed point', async () => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  let pushed = 0;
  for (const chunk of BEFORE_RESIZE) {
    keeper.push(chunk);
    pushed += chunk.length;
  }
  await keeperParsedAll(keeper, pushed);
  const first = keeper.serialize();

  const replay = newTerminal(START_COLS, START_ROWS);
  await write(replay, SCREEN_RESET + first);
  const second = keeper.serialize();
  assert.equal(second, first, 'the keeper is not disturbed by being serialized twice');

  keeper.dispose();
  replay.dispose();
});

test('a disposed keeper stops parsing and stops resizing', async () => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  keeper.push('before dispose\r\n');
  await keeperParsedAll(keeper, 'before dispose\r\n'.length);
  keeper.dispose();
  keeper.push('after dispose\r\n');
  keeper.resize(20, 5);
  keeper.dispose();
  assert.equal(keeper.parsedOffset(), 'before dispose\r\n'.length);
});
