'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');

const { createStatusSource } = require('../detection/status-source');

function collect(src) {
  const out = [];
  src.on('status', (s) => out.push(s));
  return out;
}

test('working/resume/awaiting-input emit immediately', async () => {
  const src = createStatusSource({ sessionId: 's1' });
  const out = collect(src);
  src.ingest({ signal: 'working', source: 'title' });
  src.ingest({ signal: 'awaiting-input', source: 'hook' });
  src.ingest({ signal: 'resume', source: 'hook' });
  await sleep(5);
  assert.deepEqual(out.map((s) => s.signal), ['working', 'awaiting-input', 'resume']);
  src.destroy();
});

test('ready is held for the conflict window then emitted', async () => {
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 60 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' });
  await sleep(20);
  assert.equal(out.length, 0, 'ready not emitted yet (held)');
  await sleep(70);
  assert.equal(out.length, 1);
  assert.equal(out[0].signal, 'ready');
  assert.equal(out[0].confidence, 'high');
  src.destroy();
});

test('awaiting-input during conflict window cancels a pending ready (no spurious COMPLETE)', async () => {
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 80 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' }); // Stop
  await sleep(20);
  src.ingest({ signal: 'awaiting-input', source: 'hook' }); // Notification(idle/permission)
  await sleep(120);
  assert.deepEqual(out.map((s) => s.signal), ['awaiting-input'], 'ready must be suppressed');
  src.destroy();
});

test('double ready (Stop double-fire) collapses to a single emission', async () => {
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 50 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' });
  src.ingest({ signal: 'ready', source: 'hook' }); // duplicate within window
  await sleep(90);
  assert.equal(out.filter((s) => s.signal === 'ready').length, 1);
  src.destroy();
});

test('dedup collapses rapid duplicate resolved signals', async () => {
  const src = createStatusSource({ sessionId: 's1', dedupWindowMs: 100 });
  const out = collect(src);
  src.ingest({ signal: 'working', source: 'title' });
  src.ingest({ signal: 'working', source: 'title' });
  await sleep(5);
  assert.equal(out.filter((s) => s.signal === 'working').length, 1);
  src.destroy();
});

test('title ready and hook ready collapse (precedence/dedup)', async () => {
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 40, dedupWindowMs: 200 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' });
  await sleep(60); // hook ready emitted
  src.ingest({ signal: 'ready', source: 'title' });
  await sleep(60);
  assert.equal(out.filter((s) => s.signal === 'ready').length, 1, 'second ready deduped');
  src.destroy();
});

test('unknown is forwarded as meta, never as a status transition', async () => {
  const src = createStatusSource({ sessionId: 's1' });
  const status = collect(src);
  const meta = [];
  src.on('meta', (m) => meta.push(m));
  src.ingest({ signal: 'unknown', source: 'title' });
  await sleep(5);
  assert.equal(status.length, 0);
  assert.equal(meta.length, 1);
  assert.equal(meta[0].signal, 'unknown');
  src.destroy();
});

test('destroy stops further emissions', async () => {
  const src = createStatusSource({ sessionId: 's1', conflictWindowMs: 30 });
  const out = collect(src);
  src.ingest({ signal: 'ready', source: 'hook' });
  src.destroy();
  await sleep(60);
  assert.equal(out.length, 0);
});
