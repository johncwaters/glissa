// ESM re-export of shared/states for Vite import resolution.
// Server-side code uses states.js (CommonJS). Vite aliases /shared/states.mjs to this file.

export const STATES = Object.freeze({
  INITIALIZING: 'INITIALIZING',
  STARTING:     'STARTING',
  RUNNING:      'RUNNING',
  WAITING:      'WAITING',
  IDLE:         'IDLE',
  DONE:         'DONE',
  FAILED:       'FAILED',
});

export const BADGE_LABELS = Object.freeze({
  [STATES.INITIALIZING]: 'Preparing',
  [STATES.STARTING]:     'Starting',
  [STATES.RUNNING]:      'Running',
  [STATES.WAITING]:      'Needs Input',
  [STATES.IDLE]:         'Idle',
  [STATES.DONE]:         'Done',
  [STATES.FAILED]:       'Failed',
});

export const KILLABLE_STATES    = Object.freeze([STATES.RUNNING, STATES.WAITING, STATES.IDLE]);
export const RESTARTABLE_STATES = Object.freeze([STATES.DONE, STATES.FAILED]);
export const DISMISSABLE_STATES = Object.freeze([STATES.WAITING]);
