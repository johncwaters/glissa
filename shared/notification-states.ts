
export const NOTIFICATION_STATES = Object.freeze({
  IDLE:         'IDLE',
  PENDING:      'PENDING',
  SUPPRESSED:   'SUPPRESSED',
  DELIVERED:    'DELIVERED',
  ESCALATED:    'ESCALATED',
  ESCALATED_PHONE: 'ESCALATED_PHONE',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
} as const);

export type NotificationState = (typeof NOTIFICATION_STATES)[keyof typeof NOTIFICATION_STATES];

export const NOTIFICATION_TRANSITIONS: Readonly<Record<NotificationState, Readonly<Partial<Record<string, NotificationState>>>>> = Object.freeze({
  [NOTIFICATION_STATES.IDLE]: {
    trigger:           NOTIFICATION_STATES.PENDING,
  },
  [NOTIFICATION_STATES.PENDING]: {
    suppressed:        NOTIFICATION_STATES.SUPPRESSED,
    debounced:         NOTIFICATION_STATES.IDLE,
    deliver:           NOTIFICATION_STATES.DELIVERED,
    acknowledge:       NOTIFICATION_STATES.IDLE,
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
  [NOTIFICATION_STATES.SUPPRESSED]: {
    trigger:           NOTIFICATION_STATES.PENDING,
    unsuppress:        NOTIFICATION_STATES.PENDING,
    acknowledge:       NOTIFICATION_STATES.IDLE,
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
  [NOTIFICATION_STATES.DELIVERED]: {
    trigger:           NOTIFICATION_STATES.PENDING,
    escalation_tick:   NOTIFICATION_STATES.ESCALATED,
    phone_escalation:  NOTIFICATION_STATES.ESCALATED_PHONE,
    acknowledge:       NOTIFICATION_STATES.ACKNOWLEDGED,
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
  [NOTIFICATION_STATES.ESCALATED]: {
    trigger:           NOTIFICATION_STATES.PENDING,
    escalation_tick:   NOTIFICATION_STATES.DELIVERED,
    phone_escalation:  NOTIFICATION_STATES.ESCALATED_PHONE,
    acknowledge:       NOTIFICATION_STATES.ACKNOWLEDGED,
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
  [NOTIFICATION_STATES.ESCALATED_PHONE]: {
    trigger:           NOTIFICATION_STATES.PENDING,
    escalation_tick:   NOTIFICATION_STATES.DELIVERED,
    acknowledge:       NOTIFICATION_STATES.ACKNOWLEDGED,
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
  [NOTIFICATION_STATES.ACKNOWLEDGED]: {
    reset:             NOTIFICATION_STATES.IDLE,
    session_destroyed: NOTIFICATION_STATES.IDLE,
  },
});

