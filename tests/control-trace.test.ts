import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import type { Session } from '../session/sessions.ts';
import type { TraceRecord } from '../shared/contracts/trace.ts';
import { REFRESHABLE_TYPES } from '../server/core/control-send-core.ts';
import {
  MAX_SESSION_TRACE_READ_BYTES,
  sessionTracePageFromBytes,
} from '../server/core/session-trace-core.ts';
import { createTraceChangeBroadcast, TRACE_CHANGE_COALESCE_MS } from '../server/trace-control.ts';
import { createTraceWiring } from '../server/trace-wiring.ts';
import type { TracePage, TracePageRequest } from '../server/trace-wiring.ts';
import { plainSession } from './helpers/fake-session.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

interface TraceFrame {
  type: string;
  id?: string;
  records?: TraceRecord[];
  start?: number;
  next?: number;
  reset?: boolean;
  path?: string;
  message?: string;
}

const baseRecord = {
  ts: 1,
  uuid: null,
  parentUuid: null,
  vendorSessionId: 'vendor-session',
};

function assistantRecord(text: string): TraceRecord {
  return { ...baseRecord, kind: 'assistant', text };
}

function traceLine(record: TraceRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function tracePageRequest(now = 7, vendorSessionId = 'vendor-session') {
  return {
    after: 0,
    size: 0,
    now,
    vendorSessionId,
    readBytes: async () => new Uint8Array(),
  };
}

type TracePageReader = (glimmervoidSessionId: string, request: TracePageRequest) => Promise<TracePage>;

function traceWorkspace(name: string): { traceDirectory: string; readTracePage: TracePageReader } {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `glimmervoid-control-trace-${name}-`));
  temporaryDirectories.push(configDirectory);
  const traceDirectory = path.join(configDirectory, 'traces');
  fs.mkdirSync(traceDirectory, { recursive: true });
  const wiring = createTraceWiring({
    configPath: path.join(configDirectory, 'config.json'),
    logger: { log: () => {}, warn: () => {} },
    nowFn: () => 7,
  });
  return { traceDirectory, readTracePage: wiring.readTracePage };
}

function traceHarness(readTracePage: TracePageReader, trust: 'local' | 'remote' = 'local') {
  const session = plainSession('session-1');
  const sessions = new Map<string, Session>([[session.id, session]]);
  const server = createControlServer(controlDeps({ projects: [] }, { sessions, readTracePage }));
  const connection = connectControl<TraceFrame>(server, { trust });
  connection.sent.length = 0;
  return connection;
}

test('the byte core parses complete schema-valid lines and leaves an incomplete tail for continuation', () => {
  const first = traceLine(assistantRecord('first'));
  const partial = traceLine(assistantRecord('second')).slice(0, -2);
  const afterOffset = 19;
  const page = sessionTracePageFromBytes(tracePageRequest(), afterOffset, Buffer.from(first + partial));
  assert.deepEqual(page.records, [assistantRecord('first')]);
  assert.equal(page.start, afterOffset);
  assert.equal(page.next, afterOffset + Buffer.byteLength(first));
});

test('a corrupt JSON line between valid records yields an unreadable notice without changing the next offset', () => {
  const firstLine = traceLine(assistantRecord('first'));
  const corruptLine = '{not json}\n';
  const secondLine = traceLine(assistantRecord('second'));
  const page = sessionTracePageFromBytes(
    tracePageRequest(9, 'trace-vendor'),
    0,
    Buffer.from(firstLine + corruptLine + secondLine),
  );

  assert.deepEqual(page.records, [
    assistantRecord('first'),
    {
      ts: 9,
      uuid: null,
      parentUuid: null,
      vendorSessionId: 'trace-vendor',
      kind: 'notice',
      text: `unreadable trace record of ${Buffer.byteLength(corruptLine)} bytes`,
    },
    assistantRecord('second'),
  ]);
  assert.equal(page.next, Buffer.byteLength(firstLine + corruptLine + secondLine));
});

test('a JSON line that fails the trace schema yields an unreadable notice', () => {
  const invalidRecordLine = `${JSON.stringify({ kind: 'assistant', text: 'missing fields' })}\n`;
  const page = sessionTracePageFromBytes(tracePageRequest(11, 'trace-vendor'), 0, Buffer.from(invalidRecordLine));

  assert.deepEqual(page.records, [{
    ts: 11,
    uuid: null,
    parentUuid: null,
    vendorSessionId: 'trace-vendor',
    kind: 'notice',
    text: `unreadable trace record of ${Buffer.byteLength(invalidRecordLine)} bytes`,
  }]);
  assert.equal(page.next, Buffer.byteLength(invalidRecordLine));
});

test('a line holding invalid UTF-8 reports its raw on-disk byte length including the newline', () => {
  const corruptBytes = Buffer.from([0x7b, 0x80, 0x81, 0x7d, 0x0a]);
  const page = sessionTracePageFromBytes(tracePageRequest(13, 'trace-vendor'), 0, corruptBytes);

  assert.deepEqual(page.records, [{
    ts: 13,
    uuid: null,
    parentUuid: null,
    vendorSessionId: 'trace-vendor',
    kind: 'notice',
    text: 'unreadable trace record of 5 bytes',
  }]);
  assert.equal(page.next, corruptBytes.length);
});

test('a blank trace line yields no record', () => {
  const blankLine = ' \t\n';
  const page = sessionTracePageFromBytes(tracePageRequest(), 0, Buffer.from(blankLine));

  assert.deepEqual(page.records, []);
  assert.equal(page.next, Buffer.byteLength(blankLine));
});

test('session-trace replies from zero with the file path and continues from the returned byte offset', async () => {
  const { traceDirectory, readTracePage } = traceWorkspace('pages');
  const firstText = 'a'.repeat(Math.floor(MAX_SESSION_TRACE_READ_BYTES * 0.6));
  const secondText = 'b'.repeat(Math.floor(MAX_SESSION_TRACE_READ_BYTES * 0.6));
  const tracePath = path.join(traceDirectory, 'session-1.jsonl');
  fs.writeFileSync(tracePath, traceLine(assistantRecord(firstText)) + traceLine(assistantRecord(secondText)));
  const connection = traceHarness(readTracePage);

  await connection.send({ type: 'session-trace', id: 'session-1' });
  const firstPage = connection.sent.find((frame) => frame.type === 'session-trace-response');
  assert.ok(firstPage);
  assert.equal(firstPage.records?.length, 1);
  assert.equal(firstPage.records?.[0].kind, 'assistant');
  assert.equal(firstPage.start, 0);
  assert.equal(firstPage.next, Buffer.byteLength(traceLine(assistantRecord(firstText))));
  assert.equal(firstPage.reset, false);
  assert.equal(firstPage.path, tracePath);

  connection.sent.length = 0;
  await connection.send({ type: 'session-trace', id: 'session-1', after: firstPage.next });
  const secondPage = connection.sent.find((frame) => frame.type === 'session-trace-response');
  assert.ok(secondPage);
  assert.equal(secondPage.records?.length, 1);
  assert.equal(secondPage.next, fs.statSync(tracePath).size);
});

test('a record larger than one page is skipped with a notice so paging cannot stall', async () => {
  const { traceDirectory, readTracePage } = traceWorkspace('oversized');
  const oversizedLine = traceLine(assistantRecord('x'.repeat(700 * 1024)));
  const followingLine = traceLine(assistantRecord('after the big one'));
  fs.writeFileSync(path.join(traceDirectory, 'session-1.jsonl'), oversizedLine + followingLine);
  const connection = traceHarness(readTracePage);

  await connection.send({ type: 'session-trace', id: 'session-1', after: 0 });
  const skipPage = connection.sent.find((frame) => frame.type === 'session-trace-response');
  assert.ok(skipPage);
  assert.equal(skipPage.next, Buffer.byteLength(oversizedLine));
  assert.equal(skipPage.records?.length, 1);
  const notice = skipPage.records?.[0];
  assert.equal(notice?.kind, 'notice');
  assert.match(notice?.kind === 'notice' ? notice.text : '', new RegExp(`${Buffer.byteLength(oversizedLine)} byte record`));

  connection.sent.length = 0;
  await connection.send({ type: 'session-trace', id: 'session-1', after: skipPage.next });
  const nextPage = connection.sent.find((frame) => frame.type === 'session-trace-response');
  assert.equal(nextPage?.records?.length, 1);
  assert.equal(nextPage?.records?.[0].kind, 'assistant');
});

test('a cursor past the end of a shrunk or removed trace comes back with the reset flag', async () => {
  const { traceDirectory, readTracePage } = traceWorkspace('reset');
  const line = traceLine(assistantRecord('only line'));
  fs.writeFileSync(path.join(traceDirectory, 'session-1.jsonl'), line);
  const connection = traceHarness(readTracePage);

  await connection.send({ type: 'session-trace', id: 'session-1', after: Buffer.byteLength(line) * 4 });
  const shrunk = connection.sent.find((frame) => frame.type === 'session-trace-response');
  assert.equal(shrunk?.reset, true);
  assert.equal(shrunk?.next, Buffer.byteLength(line));

  connection.sent.length = 0;
  fs.rmSync(path.join(traceDirectory, 'session-1.jsonl'));
  await connection.send({ type: 'session-trace', id: 'session-1', after: 10 });
  const removed = connection.sent.find((frame) => frame.type === 'session-trace-response');
  assert.equal(removed?.reset, true);
  assert.equal(removed?.next, 0);
  assert.deepEqual(removed?.records, []);
});

test('a remote socket is served the requested trace page', async () => {
  const { traceDirectory, readTracePage } = traceWorkspace('remote');
  fs.writeFileSync(path.join(traceDirectory, 'session-1.jsonl'), traceLine(assistantRecord('secret')));
  const connection = traceHarness(readTracePage, 'remote');
  await connection.send({ type: 'session-trace', id: 'session-1', after: 0 });
  const response = connection.sent.find((frame) => frame.type === 'session-trace-response');
  assert.equal(response?.id, 'session-1');
  assert.deepEqual(response?.records, [assistantRecord('secret')]);
  assert.equal(connection.sent.some((frame) => frame.type === 'error'), false);
});

test('an unknown session is refused with an error frame naming the requested session', async () => {
  const { readTracePage } = traceWorkspace('unknown');
  const connection = traceHarness(readTracePage);
  await connection.send({ type: 'session-trace', id: 'session-missing', after: 0 });
  assert.equal(connection.sent.some((frame) => frame.type === 'session-trace-response'), false);
  const refusal = connection.sent.find((frame) => frame.type === 'error');
  assert.match(refusal?.message ?? '', /Session not found/);
  assert.equal(refusal?.id, 'session-missing');
});

test('a tail request seeds from the last page and an earlier request walks back to the start', async () => {
  const { traceDirectory, readTracePage } = traceWorkspace('tail');
  const pageText = 'a'.repeat(Math.floor(MAX_SESSION_TRACE_READ_BYTES * 0.6));
  const firstLine = traceLine(assistantRecord(`first ${pageText}`));
  const secondLine = traceLine(assistantRecord(`second ${pageText}`));
  const tracePath = path.join(traceDirectory, 'session-1.jsonl');
  fs.writeFileSync(tracePath, firstLine + secondLine);
  const connection = traceHarness(readTracePage);

  await connection.send({ type: 'session-trace', id: 'session-1', endingAt: 'tail' });
  const tailPage = connection.sent.find((frame) => frame.type === 'session-trace-response');
  assert.ok(tailPage);
  assert.equal(tailPage.records?.length, 1);
  assert.equal(tailPage.records?.[0].kind === 'assistant' ? tailPage.records[0].text.startsWith('second') : false, true);
  assert.equal(tailPage.start, Buffer.byteLength(firstLine));
  assert.equal(tailPage.next, fs.statSync(tracePath).size);
  assert.equal(tailPage.reset, false);

  connection.sent.length = 0;
  await connection.send({ type: 'session-trace', id: 'session-1', endingAt: tailPage.start });
  const earlierPage = connection.sent.find((frame) => frame.type === 'session-trace-response');
  assert.ok(earlierPage);
  assert.equal(earlierPage.records?.length, 1);
  assert.equal(earlierPage.records?.[0].kind === 'assistant' ? earlierPage.records[0].text.startsWith('first') : false, true);
  assert.equal(earlierPage.start, 0);
  assert.equal(earlierPage.next, Buffer.byteLength(firstLine));
});

test('a terminated oversized tail record is skipped once with its full byte size', async () => {
  const { traceDirectory, readTracePage } = traceWorkspace('terminated-tail');
  const firstLine = traceLine(assistantRecord('before the oversized tail'));
  const oversizedLine = traceLine(assistantRecord('x'.repeat(700 * 1024)));
  const tracePath = path.join(traceDirectory, 'session-1.jsonl');
  fs.writeFileSync(tracePath, firstLine + oversizedLine);
  const connection = traceHarness(readTracePage);

  await connection.send({ type: 'session-trace', id: 'session-1', endingAt: 'tail' });
  const tailPage = connection.sent.find((frame) => frame.type === 'session-trace-response');
  assert.ok(tailPage);
  assert.equal(tailPage.start, Buffer.byteLength(firstLine));
  assert.equal(tailPage.next, fs.statSync(tracePath).size);
  assert.equal(tailPage.records?.length, 1);
  const notice = tailPage.records?.[0];
  assert.match(notice?.kind === 'notice' ? notice.text : '', new RegExp(`${Buffer.byteLength(oversizedLine)} byte record`));
});

test('an unterminated oversized tail record keeps the forward cursor on its line boundary', async () => {
  const { traceDirectory, readTracePage } = traceWorkspace('unterminated-tail');
  const firstLine = traceLine(assistantRecord('before the oversized tail'));
  const oversizedTail = traceLine(assistantRecord('x'.repeat(700 * 1024))).slice(0, -1);
  const tracePath = path.join(traceDirectory, 'session-1.jsonl');
  fs.writeFileSync(tracePath, firstLine + oversizedTail);
  const connection = traceHarness(readTracePage);

  await connection.send({ type: 'session-trace', id: 'session-1', endingAt: 'tail' });
  const tailPage = connection.sent.find((frame) => frame.type === 'session-trace-response');
  assert.ok(tailPage);
  assert.equal(tailPage.start, Buffer.byteLength(firstLine));
  assert.equal(tailPage.next, Buffer.byteLength(firstLine));
  assert.equal(tailPage.records?.length, 1);
  const notice = tailPage.records?.[0];
  assert.match(notice?.kind === 'notice' ? notice.text : '', new RegExp(`${Buffer.byteLength(oversizedTail)} byte record`));
});

test('a read failure answers an error frame naming the session so the panel can stop waiting', async () => {
  const failingRead: TracePageReader = async () => { throw new Error('disk gone'); };
  const connection = traceHarness(failingRead);
  await connection.send({ type: 'session-trace', id: 'session-1', after: 0 });
  const failure = connection.sent.find((frame) => frame.type === 'error');
  assert.equal(failure?.id, 'session-1');
  assert.match(failure?.message ?? '', /disk gone/);
});

test('trace changes use the all-control broadcast and append bursts coalesce by session', () => {
  assert.equal(REFRESHABLE_TYPES.has('session-trace-changed'), true);
  const backendLanesSource = fs.readFileSync(new URL('../server/backend-lanes.ts', import.meta.url), 'utf8');
  assert.match(backendLanesSource, /createTraceChangeBroadcast\(\{ source: traceWiring, broadcast: broadcastControl \}\)/);
  const source = new EventEmitter();
  const scheduled = new Map<NodeJS.Timeout, () => void>();
  const broadcasts: Record<string, unknown>[] = [];
  const notifier = createTraceChangeBroadcast({
    source,
    broadcast: (message) => { broadcasts.push(message); },
    setTimeoutFunction: (listener, delayMs) => {
      assert.equal(delayMs, TRACE_CHANGE_COALESCE_MS);
      const handle = setTimeout(() => {}, 2 ** 30);
      handle.unref();
      scheduled.set(handle, listener);
      return handle;
    },
    clearTimeoutFunction: (handle) => {
      clearTimeout(handle);
      scheduled.delete(handle);
    },
  });

  source.emit('trace-appended', { id: 'a' });
  source.emit('trace-appended', { id: 'a' });
  source.emit('trace-appended', { id: 'b' });
  assert.equal(scheduled.size, 2);
  for (const [handle, listener] of [...scheduled]) {
    clearTimeout(handle);
    scheduled.delete(handle);
    listener();
  }
  assert.deepEqual(broadcasts, [
    { type: 'session-trace-changed', id: 'a' },
    { type: 'session-trace-changed', id: 'b' },
  ]);
  notifier.stop();
});
