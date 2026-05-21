'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../sessions');
const { STATES } = require('../shared/states');

function makeSession() {
  const sess = new Session({
    id: 'test-id',
    name: 'test',
    path: process.cwd(),
    inputGraceSeconds: 5,
  });
  return sess;
}

function inIdle(sess) {
  sess.state = STATES.IDLE;
}

function inComplete(sess) {
  sess.state = STATES.COMPLETE;
}

test('_isUserEchoData: no prior input returns false', () => {
  const sess = makeSession();
  assert.equal(sess._isUserEchoData(), false);
  sess.destroy();
});

test('_isUserEchoData: recent non-submit input returns true', () => {
  const sess = makeSession();
  sess.recordUserInput('h');
  assert.equal(sess._isUserEchoData(), true);
  sess.destroy();
});

test('_isUserEchoData: recent submit input (\\n) returns false', () => {
  const sess = makeSession();
  sess.recordUserInput('hello\n');
  assert.equal(sess._isUserEchoData(), false);
  sess.destroy();
});

test('_isUserEchoData: recent submit input (\\r) returns false', () => {
  const sess = makeSession();
  sess.recordUserInput('hello\r');
  assert.equal(sess._isUserEchoData(), false);
  sess.destroy();
});

test('_isUserEchoData: stale input (beyond grace) returns false', () => {
  const sess = makeSession();
  sess.recordUserInput('h');
  sess._lastUserInputAt = Date.now() - (sess._inputGraceMs + 100);
  assert.equal(sess._isUserEchoData(), false);
  sess.destroy();
});

test('_isUserEchoData: recordUserInput() without args preserves prior flag', () => {
  const sess = makeSession();
  sess.recordUserInput('h');
  assert.equal(sess._lastInputWasSubmit, false);
  // Simulate dismiss() path which calls recordUserInput() with no args
  sess.recordUserInput();
  assert.equal(sess._lastInputWasSubmit, false, 'flag preserved');
  assert.ok(sess._lastUserInputAt > 0, 'timestamp still updated');
  sess.destroy();
});

test('IDLE handler: suppresses transition when user typed recently (non-submit)', () => {
  const sess = makeSession();
  inIdle(sess);
  sess.recordUserInput('h');
  const auditBefore = sess.auditLog.length;

  const transitions = [];
  sess.on('state-change', (e) => transitions.push(e));

  sess._handlePtyData('h');

  assert.equal(sess.state, STATES.IDLE, 'state stayed IDLE');
  assert.equal(transitions.length, 0, 'no transition fired');
  assert.equal(sess.auditLog.length, auditBefore, 'no audit entry on suppressed echo');
  sess.destroy();
});

test('IDLE handler: transitions to RUNNING when last input was a submit', () => {
  const sess = makeSession();
  inIdle(sess);
  sess.recordUserInput('hello\n');

  const transitions = [];
  sess.on('state-change', (e) => transitions.push(e));

  sess._handlePtyData('hello\r\n');

  assert.equal(sess.state, STATES.RUNNING);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].event, 'new_output');
  sess.destroy();
});

test('IDLE handler: transitions to RUNNING when input is stale (>grace)', () => {
  const sess = makeSession();
  inIdle(sess);
  sess.recordUserInput('h');
  sess._lastUserInputAt = Date.now() - (sess._inputGraceMs + 100);

  const transitions = [];
  sess.on('state-change', (e) => transitions.push(e));

  sess._handlePtyData('some claude output');

  assert.equal(sess.state, STATES.RUNNING);
  assert.equal(transitions.length, 1);
  sess.destroy();
});

test('IDLE handler: transitions to RUNNING when no prior user input', () => {
  const sess = makeSession();
  inIdle(sess);

  const transitions = [];
  sess.on('state-change', (e) => transitions.push(e));

  sess._handlePtyData('claude output');

  assert.equal(sess.state, STATES.RUNNING);
  assert.equal(transitions.length, 1);
  sess.destroy();
});

test('COMPLETE handler: suppresses transition when user typed recently (non-submit)', () => {
  const sess = makeSession();
  inComplete(sess);
  sess.recordUserInput('g');
  const auditBefore = sess.auditLog.length;

  const transitions = [];
  sess.on('state-change', (e) => transitions.push(e));

  sess._handlePtyData('g');

  assert.equal(sess.state, STATES.COMPLETE);
  assert.equal(transitions.length, 0);
  assert.equal(sess.auditLog.length, auditBefore, 'no audit entry on suppressed echo');
  sess.destroy();
});

test('COMPLETE handler: transitions to RUNNING when last input was a submit', () => {
  const sess = makeSession();
  inComplete(sess);
  sess.recordUserInput('cmd\n');

  const transitions = [];
  sess.on('state-change', (e) => transitions.push(e));

  sess._handlePtyData('output');

  assert.equal(sess.state, STATES.RUNNING);
  assert.equal(transitions.length, 1);
  sess.destroy();
});

test('COMPLETE handler: transitions to RUNNING when input is stale', () => {
  const sess = makeSession();
  inComplete(sess);
  sess.recordUserInput('g');
  sess._lastUserInputAt = Date.now() - (sess._inputGraceMs + 100);

  const transitions = [];
  sess.on('state-change', (e) => transitions.push(e));

  sess._handlePtyData('output');

  assert.equal(sess.state, STATES.RUNNING);
  assert.equal(transitions.length, 1);
  sess.destroy();
});

test('Subsequent submit then non-submit input updates the flag', () => {
  const sess = makeSession();
  sess.recordUserInput('cmd\n');
  assert.equal(sess._lastInputWasSubmit, true);
  sess.recordUserInput('x');
  assert.equal(sess._lastInputWasSubmit, false);
  sess.destroy();
});
