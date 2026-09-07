import test from 'node:test';
import assert from 'node:assert/strict';

import { createLaneLog } from '../server/lane-log.ts';
import type { LaneLog, LaneLogOptions } from '../server/lane-log.ts';

interface CapturedLog {
  log: LaneLog;
  notes: string[];
  warnings: string[];
}

function capture(options: LaneLogOptions = {}): CapturedLog {
  const notes: string[] = [];
  const warnings: string[] = [];
  const log = createLaneLog({
    prefix: '[ingest]',
    logger: {
      log: (message: string) => { notes.push(message); },
      warn: (message: string) => { warnings.push(message); },
    },
    ...options,
  });
  return { log, notes, warnings };
}

test('note and warn carry the prefix and go to their own logger channel', () => {
  const { log, notes, warnings } = capture();
  log.note('the git source started');
  log.warn('the git source disabled: no git');
  assert.deepEqual(notes, ['[ingest] the git source started']);
  assert.deepEqual(warnings, ['[ingest] the git source disabled: no git']);
});

test('a logger missing a channel silently drops that level', () => {
  const notes: string[] = [];
  const log = createLaneLog({
    prefix: '[visions]',
    logger: { log: (message: string) => { notes.push(message); } },
  });
  log.warn('nowhere to go');
  log.note('kept');
  assert.deepEqual(notes, ['[visions] kept']);

  const silent = createLaneLog({ prefix: '[visions]', logger: null });
  silent.note('no logger at all');
  silent.warn('no logger at all');
});

test('debugNote is off by default and never builds the message it would have logged', () => {
  const { log, notes } = capture();
  let builtCount = 0;
  log.debugNote(() => { builtCount += 1; return 'expensive'; });
  assert.equal(builtCount, 0, 'a line nobody wants costs no interpolation');
  assert.deepEqual(notes, []);
});

test('debugNote accepts a boolean flag or a getter, and the getter is read per line', () => {
  const fixed = capture({ debugFlag: true });
  fixed.log.debugNote(() => 'always on');
  assert.deepEqual(fixed.notes, ['[ingest] always on']);

  let isDebugOn = false;
  const dynamic = capture({ debugFlag: () => isDebugOn });
  dynamic.log.debugNote(() => 'before');
  isDebugOn = true;
  dynamic.log.debugNote(() => 'after');
  assert.deepEqual(dynamic.notes, ['[ingest] after'], 'the setting moves while the lane stays up');
});

test('a debug getter that throws reads as off rather than propagating', () => {
  const { log, notes, warnings } = capture({ debugFlag: () => { throw new Error('settings unavailable'); } });
  assert.doesNotThrow(() => log.debugNote(() => 'suppressed'));
  assert.deepEqual(notes, []);
  assert.deepEqual(warnings, [], 'a failed debug check is not itself news');
});

test('note and warn render fields as key=value pairs after the message, in object key order, behind the prefix', () => {
  const { log, notes, warnings } = capture();
  log.note('started', { source: 'git', retryCount: 2, enabled: true });
  log.warn('disabled', { source: 'git', retryCount: 2, enabled: false });
  assert.deepEqual(notes, ['[ingest] started source=git retryCount=2 enabled=true']);
  assert.deepEqual(warnings, ['[ingest] disabled source=git retryCount=2 enabled=false']);
});

test('absent, empty, and all-null field sets leave the message byte-identical with no trailing space', () => {
  const { log, notes, warnings } = capture();
  log.note('absent');
  log.note('empty', {});
  log.warn('null', { missing: null, alsoMissing: undefined });
  assert.deepEqual(notes, ['[ingest] absent', '[ingest] empty']);
  assert.deepEqual(warnings, ['[ingest] null']);
});

test('a string value containing a space or an equals sign is quoted, a bare word and a number are not', () => {
  const { log, notes } = capture();
  log.note('values', { space: 'two words', equals: 'left=right', word: 'bare', count: 4 });
  assert.deepEqual(notes, ['[ingest] values space="two words" equals="left=right" word=bare count=4']);
});

test('warnOnce emits once per key and emits again for a different key', () => {
  const { log, warnings } = capture();
  log.warnOnce('first', 'first warning');
  log.warnOnce('first', 'first warning');
  log.warnOnce('second', 'second warning');
  assert.deepEqual(warnings, ['[ingest] first warning', '[ingest] second warning']);
});

test('warnOnce past 256 keys keeps warning for new keys and forgets the oldest', () => {
  const { log, warnings } = capture();
  for (let keyNumber = 1; keyNumber <= 300; keyNumber += 1) {
    log.warnOnce(`key-${keyNumber}`, `warning ${keyNumber}`);
  }
  log.warnOnce('key-1', 'warning 1 again');
  assert.equal(warnings.length, 301);
  assert.equal(warnings.at(-1), '[ingest] warning 1 again');
});

test('warnOnce marks the key before emitting so a logger that throws on the first call still suppresses the second', () => {
  let warningCalls = 0;
  const log = createLaneLog({
    logger: {
      warn: () => {
        warningCalls += 1;
        throw new Error('logger failed');
      },
    },
  });
  assert.throws(() => log.warnOnce('only-once', 'first'));
  assert.doesNotThrow(() => log.warnOnce('only-once', 'second'));
  assert.equal(warningCalls, 1);
});

test('debugNote builds neither the message nor the fields when debug is off, and renders both when on', () => {
  let builtMessages = 0;
  let builtFields = 0;
  const off = capture();
  off.log.debugNote(
    () => { builtMessages += 1; return 'off'; },
    () => { builtFields += 1; return { source: 'debug' }; },
  );
  assert.equal(builtMessages, 0);
  assert.equal(builtFields, 0);
  assert.deepEqual(off.notes, []);

  const on = capture({ debugFlag: true });
  on.log.debugNote(
    () => { builtMessages += 1; return 'on'; },
    () => { builtFields += 1; return { source: 'debug' }; },
  );
  assert.equal(builtMessages, 1);
  assert.equal(builtFields, 1);
  assert.deepEqual(on.notes, ['[ingest] on source=debug']);
});
