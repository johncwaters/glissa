'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerControlHandlers } = require('../server/control-handlers');

function harness() {
  const controlWss = new EventEmitter();
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-posthog-reports-'));
  const sent = [];
  let messageHandler = null;
  const ws = {
    send: (raw) => sent.push(JSON.parse(raw)),
    on: (event, handler) => {
      if (event === 'message') messageHandler = handler;
    },
  };
  registerControlHandlers(controlWss, {
    sessions: new Map(),
    config: { projects: [], teams: [] },
    configStore: { save: (fn) => fn({ projects: [], teams: [] }), getSettings: () => ({}) },
    applyConfigReload: () => {},
    broadcastControl: () => {},
    posthogReportsDir: reportDir,
  });
  controlWss.emit('connection', ws);
  sent.length = 0;
  return {
    reportDir,
    sent,
    send: async (msg) => messageHandler(JSON.stringify(msg)),
  };
}

test('get-posthog-report rejects traversal and dotted issue ids', async () => {
  const h = harness();

  await h.send({ type: 'get-posthog-report', requestId: 'r1', issueId: '../outside' });
  await h.send({ type: 'get-posthog-report', requestId: 'r2', issueId: 'issue.with.dot' });

  assert.deepEqual(h.sent.map((msg) => ({ requestId: msg.requestId, ok: msg.ok, found: msg.found, error: msg.error })), [
    { requestId: 'r1', ok: false, found: false, error: 'Invalid issue id' },
    { requestId: 'r2', ok: false, found: false, error: 'Invalid issue id' },
  ]);
});

test('get-posthog-report returns not found for a missing report', async () => {
  const h = harness();

  await h.send({ type: 'get-posthog-report', requestId: 'r1', issueId: 'iss-1' });

  assert.deepEqual(h.sent[0], {
    type: 'posthog-report',
    requestId: 'r1',
    ok: true,
    found: false,
    issueId: 'iss-1',
    message: 'Report not found',
  });
});

test('get-posthog-report reads the markdown report for a safe issue id', async () => {
  const h = harness();
  fs.writeFileSync(path.join(h.reportDir, '018fb7a4-1a2b-7c3d-9e4f-aaaaaaaaaaaa.md'), '# Report\n\nRoot cause found.\n');

  await h.send({
    type: 'get-posthog-report',
    requestId: 'r1',
    issueId: '018fb7a4-1a2b-7c3d-9e4f-aaaaaaaaaaaa',
  });

  assert.deepEqual(h.sent[0], {
    type: 'posthog-report',
    requestId: 'r1',
    ok: true,
    found: true,
    issueId: '018fb7a4-1a2b-7c3d-9e4f-aaaaaaaaaaaa',
    content: '# Report\n\nRoot cause found.\n',
  });
});
