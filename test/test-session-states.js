'use strict';

/**
 * test-session-states.js — Session state machine test suite
 *
 * Tests state transitions, sleep/wake guards, idle timer behavior,
 * and race condition prevention.
 *
 * Run: node test/test-session-states.js
 */

const { Session } = require('../sessions');
const { STATES } = require('../shared/states');

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected: ${JSON.stringify(expected)}`);
    console.error(`        got:      ${JSON.stringify(actual)}`);
    failed++;
  }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Create a Session without spawning a PTY — for unit-testing state logic only.
// Uses short timers so tests run fast.
function makeSession(overrides = {}) {
  return new Session({
    id: 'test-' + Math.random().toString(36).slice(2, 8),
    name: 'test-session',
    path: __dirname,  // must exist (spawn_success guard checks fs.existsSync)
    attentionTimeoutSeconds: 0.1,  // 100ms idle timer
    startingWatchdogSeconds: 1,
    waitingEscalationSeconds: 1,
    autoRecoverSeconds: 0.1,
    inputGraceSeconds: 0,
    promptDetectionMs: 50,
    feedDebounceMs: 10,
    ...overrides
  });
}

// Drive a session from DORMANT to RUNNING via transitions
function driveToRunning(session) {
  session.transition('user_start');      // DORMANT -> INITIALIZING
  session.transition('spawn_success');   // INITIALIZING -> STARTING
  session.transition('first_output');    // STARTING -> RUNNING
}

// Drive a session from INITIALIZING to a target state
function driveToState(session, target) {
  driveToRunning(session);
  switch (target) {
    case STATES.RUNNING:
      break;
    case STATES.IDLE:
      session.transition('silence_timeout');
      break;
    case STATES.COMPLETE:
      session._runningStartedAt = Date.now() - 60000; // fake long run
      session.transition('task_complete');
      break;
    case STATES.WAITING:
      session.transition('prompt_detected', { layer: 1, pattern: 'test', line: 'test?' });
      break;
    case STATES.DONE:
      session.transition('process_exit_ok');
      break;
    case STATES.FAILED:
      session.transition('process_exit_fail');
      break;
    default:
      throw new Error(`driveToState: unsupported target ${target}`);
  }
}

async function runAllTests() {

  // ---- Basic transition table ----
  console.log('\nBasic state transitions:');

  {
    const s = makeSession();
    assert('initial state is DORMANT', s.state, STATES.DORMANT);
  }

  {
    const s = makeSession();
    s.transition('user_start');
    assert('DORMANT -> INITIALIZING via user_start', s.state, STATES.INITIALIZING);
  }

  {
    const s = makeSession();
    driveToRunning(s);
    assert('DORMANT -> INITIALIZING -> STARTING -> RUNNING', s.state, STATES.RUNNING);
  }

  // DORMANT only accepts user_start
  {
    const s = makeSession();
    const result = s.transition('spawn_success');
    assert('DORMANT rejects spawn_success', result, false);
    assert('DORMANT state unchanged after invalid event', s.state, STATES.DORMANT);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.IDLE);
    assert('RUNNING -> IDLE via silence_timeout', s.state, STATES.IDLE);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.COMPLETE);
    assert('RUNNING -> COMPLETE via task_complete', s.state, STATES.COMPLETE);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.WAITING);
    assert('RUNNING -> WAITING via prompt_detected', s.state, STATES.WAITING);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.IDLE);
    s.transition('new_output');
    assert('IDLE -> RUNNING via new_output', s.state, STATES.RUNNING);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.COMPLETE);
    s.transition('new_output');
    assert('COMPLETE -> RUNNING via new_output', s.state, STATES.RUNNING);
  }

  // Invalid transitions should be rejected
  {
    const s = makeSession();
    driveToRunning(s);
    const result = s.transition('spawn_success');
    assert('invalid transition returns false', result, false);
    assert('state unchanged after invalid transition', s.state, STATES.RUNNING);
  }

  // ---- Sleep state guard ----
  console.log('\nSleep state guard:');

  // Sleep should be ACCEPTED in quiescent states
  {
    const s = makeSession();
    driveToState(s, STATES.IDLE);
    s.sleep();
    assert('sleep accepted in IDLE', s.sleeping, true);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.COMPLETE);
    s.sleep();
    assert('sleep accepted in COMPLETE', s.sleeping, true);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.DONE);
    s.sleep();
    assert('sleep accepted in DONE', s.sleeping, true);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.FAILED);
    s.sleep();
    assert('sleep accepted in FAILED', s.sleeping, true);
  }

  // Sleep should be REFUSED in active states
  {
    const s = makeSession();
    driveToRunning(s);
    s.sleep();
    assert('sleep refused in RUNNING — sleeping flag', s.sleeping, false);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.WAITING);
    s.sleep();
    assert('sleep refused in WAITING — sleeping flag', s.sleeping, false);
  }

  {
    const s = makeSession();
    s.transition('spawn_success'); // -> STARTING
    s.sleep();
    assert('sleep refused in STARTING — sleeping flag', s.sleeping, false);
  }

  {
    const s = makeSession();
    // DORMANT (default)
    s.sleep();
    assert('sleep refused in DORMANT — sleeping flag', s.sleeping, false);
  }

  {
    const s = makeSession();
    s.transition('user_start'); // -> INITIALIZING
    s.sleep();
    assert('sleep refused in INITIALIZING — sleeping flag', s.sleeping, false);
  }

  // Sleep event should NOT be emitted when refused
  {
    const s = makeSession();
    driveToRunning(s);
    let sleepEmitted = false;
    s.on('sleep', () => { sleepEmitted = true; });
    s.sleep();
    assert('sleep event not emitted when refused in RUNNING', sleepEmitted, false);
  }

  // Sleep event SHOULD be emitted when accepted
  {
    const s = makeSession();
    driveToState(s, STATES.IDLE);
    let sleepEmitted = false;
    s.on('sleep', () => { sleepEmitted = true; });
    s.sleep();
    assert('sleep event emitted when accepted in IDLE', sleepEmitted, true);
  }

  // Sleep is idempotent
  {
    const s = makeSession();
    driveToState(s, STATES.IDLE);
    s.sleep();
    assert('first sleep accepted', s.sleeping, true);
    let secondEmit = false;
    s.on('sleep', () => { secondEmit = true; });
    s.sleep();
    assert('second sleep is no-op (no re-emit)', secondEmit, false);
    assert('still sleeping after idempotent call', s.sleeping, true);
  }

  // ---- Wake behavior ----
  console.log('\nWake behavior:');

  {
    const s = makeSession();
    driveToState(s, STATES.IDLE);
    s.sleep();
    assert('sleeping before wake', s.sleeping, true);
    s.wake();
    assert('not sleeping after wake', s.sleeping, false);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.IDLE);
    let wakeEmitted = false;
    s.on('wake', () => { wakeEmitted = true; });
    s.sleep();
    s.wake();
    assert('wake event emitted', wakeEmitted, true);
  }

  // Wake is idempotent
  {
    const s = makeSession();
    driveToState(s, STATES.IDLE);
    let wakeCount = 0;
    s.on('wake', () => { wakeCount++; });
    s.wake(); // not sleeping — should be no-op
    assert('wake on non-sleeping session is no-op', wakeCount, 0);
  }

  // ---- Race condition: IDLE -> RUNNING -> sleep refused ----
  console.log('\nRace condition prevention:');

  {
    const s = makeSession();
    driveToRunning(s);
    // Simulate: idle timer fires -> IDLE, then new data -> back to RUNNING
    s.transition('silence_timeout');    // RUNNING -> IDLE
    assert('transitioned to IDLE', s.state, STATES.IDLE);
    s.transition('new_output');         // IDLE -> RUNNING
    assert('transitioned back to RUNNING', s.state, STATES.RUNNING);
    // Now the stale sleep command arrives
    s.sleep();
    assert('race: sleep refused after IDLE->RUNNING', s.sleeping, false);
    assert('race: state still RUNNING', s.state, STATES.RUNNING);
  }

  {
    const s = makeSession();
    driveToRunning(s);
    // Same race but with COMPLETE -> RUNNING
    s._runningStartedAt = Date.now() - 60000;
    s.transition('task_complete');       // RUNNING -> COMPLETE
    assert('transitioned to COMPLETE', s.state, STATES.COMPLETE);
    s.transition('new_output');          // COMPLETE -> RUNNING
    assert('transitioned back to RUNNING', s.state, STATES.RUNNING);
    s.sleep();
    assert('race: sleep refused after COMPLETE->RUNNING', s.sleeping, false);
  }

  // ---- Sleep freezes data handlers ----
  console.log('\nSleep freezes state machine:');

  {
    const s = makeSession();
    driveToState(s, STATES.IDLE);
    s.sleep();
    // Simulate PTY data arriving while sleeping
    s._handlePtyData('some output');
    assert('state stays IDLE while sleeping (data handler skipped)', s.state, STATES.IDLE);
    assert('data still buffered while sleeping', s._outputBuffer.length > 0, true);
  }

  {
    const s = makeSession();
    driveToRunning(s);
    s.transition('silence_timeout'); // -> IDLE
    s.sleep();
    // Wake and verify state machine resumes
    s.wake();
    s._handlePtyData('new output after wake');
    assert('IDLE -> RUNNING after wake + data', s.state, STATES.RUNNING);
  }

  // ---- Idle timer behavior ----
  console.log('\nIdle timer (silence_timeout):');

  {
    const s = makeSession({ attentionTimeoutSeconds: 0.05 }); // 50ms
    driveToRunning(s);
    s._resetIdleTimer();
    assert('state is RUNNING before timeout', s.state, STATES.RUNNING);
    await delay(80);
    assert('RUNNING -> IDLE after silence timeout', s.state, STATES.IDLE);
  }

  {
    const s = makeSession({ attentionTimeoutSeconds: 0.05 }); // 50ms
    driveToRunning(s);
    s._resetIdleTimer();
    // Data arrives, resets timer
    await delay(30);
    s._resetIdleTimer(); // simulate data arrival
    await delay(30);
    assert('timer reset keeps state RUNNING', s.state, STATES.RUNNING);
    await delay(30);
    assert('IDLE after full timeout from last reset', s.state, STATES.IDLE);
  }

  // Sleep clears idle timer
  {
    const s = makeSession({ attentionTimeoutSeconds: 0.05 }); // 50ms
    driveToRunning(s);
    s._resetIdleTimer();
    s.transition('silence_timeout'); // -> IDLE
    s.sleep();
    // Idle timer was cleared by sleep — verify no crash or state change
    await delay(80);
    assert('no timer fires while sleeping', s.state, STATES.IDLE);
    assert('still sleeping', s.sleeping, true);
  }

  // ---- Long run -> COMPLETE vs short run -> IDLE ----
  console.log('\nComplete vs Idle threshold:');

  {
    const s = makeSession({ attentionTimeoutSeconds: 0.05 }); // 50ms
    driveToRunning(s);
    s._runningStartedAt = Date.now() - 60000; // fake 60s run
    s._resetIdleTimer();
    await delay(80);
    assert('long run -> COMPLETE (not IDLE)', s.state, STATES.COMPLETE);
  }

  {
    const s = makeSession({ attentionTimeoutSeconds: 0.05 }); // 50ms
    driveToRunning(s);
    s._runningStartedAt = Date.now(); // just started
    s._resetIdleTimer();
    await delay(80);
    assert('short run -> IDLE (not COMPLETE)', s.state, STATES.IDLE);
  }

  // ---- State transitions from WAITING ----
  console.log('\nWAITING state transitions:');

  {
    const s = makeSession();
    driveToState(s, STATES.WAITING);
    s.transition('user_input');
    assert('WAITING -> RUNNING via user_input', s.state, STATES.RUNNING);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.WAITING);
    s.transition('user_dismiss');
    assert('WAITING -> RUNNING via user_dismiss', s.state, STATES.RUNNING);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.WAITING);
    s.transition('auto_recover');
    assert('WAITING -> RUNNING via auto_recover', s.state, STATES.RUNNING);
  }

  // ---- Terminal states ----
  console.log('\nTerminal states:');

  {
    const s = makeSession();
    driveToState(s, STATES.DONE);
    const result = s.transition('new_output');
    assert('DONE rejects new_output', result, false);
    assert('DONE state unchanged', s.state, STATES.DONE);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.DONE);
    s.transition('user_restart');
    assert('DONE -> INITIALIZING via user_restart', s.state, STATES.INITIALIZING);
  }

  {
    const s = makeSession();
    driveToState(s, STATES.FAILED);
    s.transition('user_restart');
    assert('FAILED -> INITIALIZING via user_restart', s.state, STATES.INITIALIZING);
  }

  // ---- Summary ----
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runAllTests();
