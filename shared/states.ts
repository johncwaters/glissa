// Canonical state definitions - single source of truth for server and browser.
// Server-side: import from '../shared/states.ts'
// Browser-side: import from '#shared/states.ts', resolved by the package imports map and bundled by Vite.

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
// A live-PTY session that is quiescent (parked between turns), so merging its worktree and rebasing it
// underneath the session is safe. The single source of truth for the merge-as-you-go gate, shared by the
// server (Session.mergeAndContinue) and the client (review sidebar) so the two can never disagree. RUNNING
// is excluded (the agent is actively editing mid-turn); WAITING belongs here, because "Needs Input" means
// the agent handed control back and is waiting on the operator, NOT working. Dead-PTY states (DONE/FAILED)
// go through the pending-review/discard gate instead.
export const MERGEABLE_LIVE_STATES: readonly SessionState[] = Object.freeze([STATES.WAITING, STATES.IDLE, STATES.COMPLETE]);
