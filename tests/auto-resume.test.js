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

test('RESUME_ID_RE matches the shape control-handlers.js validates against', () => {
  assert.ok(RESUME_ID_RE.test('4a3d4462-4cf7-4a23-8f00-ccec89a48ba5'));
  assert.ok(!RESUME_ID_RE.test('short'));
  assert.ok(!RESUME_ID_RE.test('has spaces in it 1234'));
});
