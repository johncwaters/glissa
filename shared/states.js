'use strict';

// Canonical state definitions — single source of truth for server and browser.
// Server-side: require('./shared/states')
// Browser-side: served dynamically as ESM via GET /shared/states.mjs

const STATES = Object.freeze({
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
  [STATES.INITIALIZING]: 'Preparing',
  [STATES.STARTING]:     'Starting',
  [STATES.RUNNING]:      'Working',
  [STATES.WAITING]:      'Needs Input',
  [STATES.IDLE]:         'Idle',
  [STATES.COMPLETE]:     'Complete',
  [STATES.DONE]:         'Exited',
  [STATES.FAILED]:       'Failed',
});

const KILLABLE_STATES = Object.freeze([STATES.RUNNING, STATES.WAITING, STATES.IDLE, STATES.COMPLETE]);
const RESTARTABLE_STATES = Object.freeze([STATES.DONE, STATES.FAILED]);
module.exports = { STATES, BADGE_LABELS, KILLABLE_STATES, RESTARTABLE_STATES };
