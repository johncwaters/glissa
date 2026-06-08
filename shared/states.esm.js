// ESM re-export of shared/states for Vite import resolution.
// Server-side code uses states.js (CommonJS). Vite aliases /shared/states.mjs to this file.

export const STATES = Object.freeze({
  DORMANT:      'DORMANT',
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

export const STATE_GLYPHS = Object.freeze({
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

export const KILLABLE_STATES    = Object.freeze([STATES.RUNNING, STATES.WAITING, STATES.IDLE, STATES.COMPLETE]);
export const RESTARTABLE_STATES = Object.freeze([STATES.DONE, STATES.FAILED]);
// Quiescent live-PTY states where merging the worktree is safe: the merge-as-you-go gate, shared verbatim
// with the server (see shared/states.js MERGEABLE_LIVE_STATES). RUNNING is excluded (mid-edit); WAITING is
// included (the agent paused for the operator, not working).
export const MERGEABLE_LIVE_STATES = Object.freeze([STATES.WAITING, STATES.IDLE, STATES.COMPLETE]);
