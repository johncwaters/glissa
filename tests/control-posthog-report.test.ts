import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

interface ReportFrame {
  type: string;
  requestId?: string;
  ok?: boolean;
  found?: boolean;
  error?: string;
}

function harness() {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-posthog-reports-'));
  const server = createControlServer(controlDeps({ projects: [] }, { posthogReportsDir: reportDir }));
  const connection = connectControl<ReportFrame>(server);
  connection.sent.length = 0;
  return { reportDir, sent: connection.sent, send: connection.send };
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

test('get-posthog-report prefers the html report when html and markdown both exist', async () => {
  const h = harness();
  const issueId = '018fb7a4-1a2b-7c3d-9e4f-aaaaaaaaaaaa';
  fs.writeFileSync(path.join(h.reportDir, `${issueId}.md`), '# Report\n\nOld report.\n');
  fs.writeFileSync(path.join(h.reportDir, `${issueId}.html`), '<!doctype html><h1>Report</h1>\n');

  await h.send({
    type: 'get-posthog-report',
    requestId: 'r1',
    issueId,
  });

  assert.deepEqual(h.sent[0], {
    type: 'posthog-report',
    requestId: 'r1',
    ok: true,
    found: true,
    issueId,
    format: 'html',
    content: '<!doctype html><h1>Report</h1>\n',
  });
});

test('get-posthog-report falls back to the markdown report for a safe issue id', async () => {
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
    format: 'markdown',
    content: '# Report\n\nRoot cause found.\n',
  });
});
