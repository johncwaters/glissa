'use strict';

// Canonical state definitions - single source of truth for server and browser.
// Server-side: require('./shared/states')
// Browser-side: /shared/states.mjs, GENERATED from these exports (the Vite plugin in vite.config.js
// for a build, the route in server/backend.js for the no-build path). Constants only: both generators
// serialize with JSON.stringify.

const STATES = Object.freeze({
  DORMANT:      'DORMANT',
  INITIALIZING: 'INITIALIZING',
  STARTING:     'STARTING',
  RUNNING:      'RUNNING',
  WAITING:      'WAITING',
  IDLE:         'IDLE',
  COMPLETE:     'COMPLETE',
  DONE:         'DONE',
  FAILED:       'FAILED'
});

const BADGE_LABELS = Object.freeze({
  [STATES.DORMANT]:      'Dormant',
  [STATES.INITIALIZING]: 'Preparing',
  [STATES.STARTING]:     'Starting',
  [STATES.RUNNING]:      'Working',
  [STATES.WAITING]:      'Needs Input',
  [STATES.IDLE]:         'Idle',
  [STATES.COMPLETE]:     'Complete',
  [STATES.DONE]:         'Exited',
  [STATES.FAILED]:       'Failed',
});

const STATE_GLYPHS = Object.freeze({
  [STATES.DORMANT]:      '\u25cb',
  [STATES.INITIALIZING]: '\u25cc',
  [STATES.STARTING]:     '\u25d0',
  [STATES.RUNNING]:      '\u25cf',
  [STATES.WAITING]:      '\u25c6',
  [STATES.IDLE]:         '\u25cd',
  [STATES.FAILED]:       '\u25b2',
  [STATES.DONE]:         '\u25a0',
  [STATES.COMPLETE]:     '\u25c7',
});

const KILLABLE_STATES = Object.freeze([
  STATES.INITIALIZING,
  STATES.STARTING,
  STATES.RUNNING,
  STATES.WAITING,
  STATES.IDLE,
  STATES.COMPLETE,
]);
/** @type {ReadonlyArray<string>} */
const RESTARTABLE_STATES = Object.freeze([STATES.DONE, STATES.FAILED]);
// A live-PTY session that is quiescent (parked between turns), so merging its worktree and rebasing it
// underneath the session is safe. The single source of truth for the merge-as-you-go gate, shared by the
// server (Session.mergeAndContinue) and the client (review sidebar) so the two can never disagree. RUNNING
// is excluded (the agent is actively editing mid-turn); WAITING belongs here, because "Needs Input" means
// the agent handed control back and is waiting on the operator, NOT working. Dead-PTY states (DONE/FAILED)
// go through the pending-review/discard gate instead.
/** @type {ReadonlyArray<string>} */
const MERGEABLE_LIVE_STATES = Object.freeze([STATES.WAITING, STATES.IDLE, STATES.COMPLETE]);
module.exports = { STATES, BADGE_LABELS, STATE_GLYPHS, KILLABLE_STATES, RESTARTABLE_STATES, MERGEABLE_LIVE_STATES };
