'use strict';

// stateSince is server-owned so a page reload cannot rebase the card's elapsed clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');

const { Session } = require('../session/sessions');
const { STATES } = require('../shared/states');

function makeSession(state) {
  const s = new Session({ id: 'state-since-test', name: 'state-since', path: process.cwd() });
  if (state) s.state = state;
  return s;
}

test('toSnapshot carries a stateSince stamped at construction', () => {
  const before = Date.now();
  const s = makeSession();
  try {
    const after = Date.now();
    const { stateSince } = s.toSnapshot();
    assert.equal(Number.isFinite(stateSince), true);
    assert.equal(stateSince >= before && stateSince <= after, true);
  } finally {
    s.destroy();
  }
});

test('a real transition rebases stateSince to the audit entry timestamp', async () => {
  const s = makeSession(STATES.RUNNING);
  try {
    const atConstruction = s.toSnapshot().stateSince;
    await sleep(5);
    assert.equal(s.transition('task_complete'), true);
    const { state, stateSince } = s.toSnapshot();
    assert.equal(state, STATES.COMPLETE);
    assert.equal(stateSince > atConstruction, true);
    const entry = s.auditLog.at(-1);
    assert.equal(entry.selfTransition, undefined);
    assert.equal(stateSince, entry.timestamp);
  } finally {
    s.destroy();
  }
});

test('a self-transition leaves stateSince alone', async () => {
  const s = makeSession(STATES.FAILED);
  try {
    const before = s.toSnapshot().stateSince;
    await sleep(5);
    assert.equal(s.transition('process_exit_fail', { code: 1 }), true);
    assert.equal(s.auditLog.at(-1).selfTransition, true);
    assert.equal(s.toSnapshot().stateSince, before);
  } finally {
    s.destroy();
  }
});

test('a refused transition leaves stateSince alone', async () => {
  const s = makeSession(STATES.IDLE);
  try {
    const before = s.toSnapshot().stateSince;
    await sleep(5);
    assert.equal(s.transition('user_start'), false);
    assert.equal(s.state, STATES.IDLE);
    assert.equal(s.toSnapshot().stateSince, before);
  } finally {
    s.destroy();
  }
});
