'use strict';

// The PR-review wiring that backend.js exports for direct testing (no createBackend/httpServer):
// the start-gate decision, the seed-prompt builder, and the result-file verdict reader. Mirrors
// backend-auto-resume.test.js, which tests backend's module-level helpers the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildReviewPrompt, readReviewResult, prPollerShouldStart } = require('../server/backend');

// --- prPollerShouldStart: inert-by-default + misconfiguration gating ---

test('prPollerShouldStart: inert when prReview absent or disabled (no reason, silent)', () => {
  assert.deepEqual(prPollerShouldStart({}), { start: false, reason: null });
  assert.deepEqual(prPollerShouldStart({ prReview: { enabled: false } }), { start: false, reason: null });
});

test('prPollerShouldStart: enabled but telegram missing -> does not start, with a reason', () => {
  const r = prPollerShouldStart({ prReview: { enabled: true } });
  assert.equal(r.start, false);
  assert.match(r.reason, /telegram/);
  const r2 = prPollerShouldStart({ prReview: { enabled: true }, telegram: { botToken: 'x' } });
  assert.equal(r2.start, false, 'chatId still missing');
});

test('prPollerShouldStart: enabled + telegram configured -> starts', () => {
  const r = prPollerShouldStart({ prReview: { enabled: true }, telegram: { botToken: 'x', chatId: '1' } });
  assert.deepEqual(r, { start: true, reason: null });
});

// --- buildReviewPrompt: clean vs conflict lane ---

test('buildReviewPrompt (clean lane) forbids merge + self-review, omits the conflict step', () => {
  const p = buildReviewPrompt({ slug: 'me/repo', number: 12, baseRefName: 'main', conflicting: false, resultPath: '/tmp/r.json' });
  assert.match(p, /pull request #12/);
  assert.match(p, /Do NOT run `gh pr merge`/);
  assert.match(p, /Do NOT use `gh pr review`/);
  assert.match(p, /\.github\/workflows\//);
  assert.match(p, /\/tmp\/r\.json/);
  assert.doesNotMatch(p, /gh pr checkout/, 'no conflict-resolution step in the clean lane');
});

test('buildReviewPrompt (conflict lane) includes checkout+rebase+push and forbids a guessed resolution', () => {
  const p = buildReviewPrompt({ slug: 'me/repo', number: 7, baseRefName: 'develop', conflicting: true, resultPath: '/tmp/r.json' });
  assert.match(p, /gh pr checkout 7/);
  assert.match(p, /git rebase origin\/develop/);
  assert.match(p, /git push/);
  assert.match(p, /Never push a guessed resolution/);
});

// --- readReviewResult: verdict file parsing ---

function withResultFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-prresult-'));
  const p = path.join(dir, 'result.json');
  if (contents != null) fs.writeFileSync(p, contents);
  try { return fn(p); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('readReviewResult: a valid verdict file parses to {verdict, summary}', () => {
  withResultFile(JSON.stringify({ verdict: 'clean', head: 'abc', summary: 'looks good' }), (p) => {
    assert.deepEqual(readReviewResult(p), { verdict: 'CLEAN', summary: 'looks good' });
  });
});

test('readReviewResult: an unknown verdict degrades to ERROR', () => {
  withResultFile(JSON.stringify({ verdict: 'LGTM' }), (p) => {
    assert.equal(readReviewResult(p).verdict, 'ERROR');
  });
});

test('readReviewResult: a missing file is ERROR (never a false clean pass)', () => {
  withResultFile(null, (p) => {
    assert.equal(readReviewResult(p).verdict, 'ERROR');
  });
});
