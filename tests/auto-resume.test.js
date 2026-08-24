'use strict';

// Pure boot-time selection logic: session/core/auto-resume.js pickAutoResume. No IO, no Session -
// see .omc/plans/graceful-shutdown-auto-resume.md design C / step 1 for the four required cases.

const test = require('node:test');
const assert = require('node:assert/strict');

const { pickAutoResume, RESUME_ID_RE } = require('../session/core/auto-resume');

test('pickAutoResume picks a project that was active and has a resumeSessionId', () => {
  const projects = [{ id: 'a', wasActive: true, resumeSessionId: 'abcd1234' }];
  assert.deepEqual(pickAutoResume(projects, { autoResume: true }), ['a']);
});

test('pickAutoResume skips a dormant project even with a resumeSessionId', () => {
  const projects = [{ id: 'a', wasActive: false, resumeSessionId: 'abcd1234' }];
  assert.deepEqual(pickAutoResume(projects, { autoResume: true }), []);
});

test('pickAutoResume skips an active project with no resumeSessionId (no silent --continue)', () => {
  const projects = [{ id: 'a', wasActive: true }];
  assert.deepEqual(pickAutoResume(projects, { autoResume: true }), []);
});

test('pickAutoResume returns nothing when autoResume is false (kill switch)', () => {
  const projects = [{ id: 'a', wasActive: true, resumeSessionId: 'abcd1234' }];
  assert.deepEqual(pickAutoResume(projects, { autoResume: false }), []);
});

test('pickAutoResume treats a missing config / autoResume field as enabled', () => {
  const projects = [{ id: 'a', wasActive: true, resumeSessionId: 'abcd1234' }];
  assert.deepEqual(pickAutoResume(projects, {}), ['a']);
  assert.deepEqual(pickAutoResume(projects, undefined), ['a']);
});

test('pickAutoResume picks only the matching subset across several projects', () => {
  const projects = [
    { id: 'picked', wasActive: true, resumeSessionId: 'abcd1234' },
    { id: 'dormant', wasActive: false, resumeSessionId: 'abcd1234' },
    { id: 'no-id', wasActive: true },
  ];
  assert.deepEqual(pickAutoResume(projects, { autoResume: true }), ['picked']);
});

test('pickAutoResume tolerates a non-array projects list', () => {
  assert.deepEqual(pickAutoResume(null, { autoResume: true }), []);
  assert.deepEqual(pickAutoResume(undefined, { autoResume: true }), []);
});

test('RESUME_ID_RE is THE session-id shape, imported by control-handlers rather than restated', () => {
  assert.ok(RESUME_ID_RE.test('4a3d4462-4cf7-4a23-8f00-ccec89a48ba5'), 'a Claude Code id');
  assert.ok(RESUME_ID_RE.test('01a030d4-6956-73c2-a74a-eedd17b6361d'), 'a codex id (UUIDv7, leading digit)');
  assert.ok(!RESUME_ID_RE.test('short'));
  assert.ok(!RESUME_ID_RE.test('has spaces in it 1234'));
  // One definition or none: a validator patched in one of two copies is still a hole.
  const controlHandlersSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'server', 'control-handlers.js'), 'utf8');
  assert.equal(/const RESUME_ID_RE\s*=\s*\//.test(controlHandlersSource), false,
    'control-handlers.js must import RESUME_ID_RE, not restate it');
});

test('a captured id can never be a FLAG: the leading character must be alphanumeric', () => {
  // A supervised session has GLISSA_HOOK_URL in its env by design, so it can POST a forged hook
  // payload to its own card. Its session_id is persisted and then spawned as a positional argument
  // (`--resume <id>` / `resume <id>`), which makes a leading dash argv injection: this exact string
  // would have turned the next spawn's sandbox and approvals off.
  assert.equal(RESUME_ID_RE.test('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(RESUME_ID_RE.test('--dangerously-skip-permissions'), false);
  assert.equal(RESUME_ID_RE.test('-p'), false);
  assert.equal(RESUME_ID_RE.test('-'.repeat(20)), false);
  assert.equal(RESUME_ID_RE.test('_leading-underscore-id'), false);
  assert.equal(RESUME_ID_RE.test(`a${'-'.repeat(127)}`), true, 'a dash is still legal after the first character');
});
