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
} as const);

export type SessionState = (typeof STATES)[keyof typeof STATES];

export const BADGE_LABELS: Readonly<Record<SessionState, string>> = Object.freeze({
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

export const STATE_GLYPHS: Readonly<Record<SessionState, string>> = Object.freeze({
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

export const KILLABLE_STATES: readonly SessionState[] = Object.freeze([
  STATES.INITIALIZING,
  STATES.STARTING,
  STATES.RUNNING,
  STATES.WAITING,
  STATES.IDLE,
  STATES.COMPLETE,
]);
export const RESTARTABLE_STATES: readonly SessionState[] = Object.freeze([STATES.DONE, STATES.FAILED]);

export const MERGEABLE_LIVE_STATES: readonly SessionState[] = Object.freeze([STATES.WAITING, STATES.IDLE, STATES.COMPLETE]);
