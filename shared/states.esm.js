// ESM re-export of shared/states for Vite import resolution.
// Server-side code uses states.js (CommonJS). Vite aliases /shared/states.mjs to this file.

export const STATES = Object.freeze({
  INITIALIZING: 'INITIALIZING',
  STARTING:     'STARTING',
  RUNNING:      'RUNNING',
  WAITING:      'WAITING',
  IDLE:         'IDLE',
  COMPLETE:     'COMPLETE',
  DONE:         'DONE',
  FAILED:       'FAILED',
});

export const BADGE_LABELS = Object.freeze({
  [STATES.INITIALIZING]: 'Preparing',
  [STATES.STARTING]:     'Starting',
  [STATES.RUNNING]:      'Working',
  [STATES.WAITING]:      'Needs Input',
  [STATES.IDLE]:         'Idle',
  [STATES.COMPLETE]:     'Complete',
  [STATES.DONE]:         'Exited',
  [STATES.FAILED]:       'Failed',
});

export const KILLABLE_STATES    = Object.freeze([STATES.RUNNING, STATES.WAITING, STATES.IDLE, STATES.COMPLETE]);
export const RESTARTABLE_STATES = Object.freeze([STATES.DONE, STATES.FAILED]);
