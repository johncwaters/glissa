'use strict';

const { z } = require('zod');
const { STATES } = require('../states');

const SessionState = z.enum(Object.values(STATES));
const PendingWakeup = z.object({
  at: z.number().finite().nullable(),
  kind: z.string(),
  reason: z.string().nullable(),
}).passthrough();

const SessionSnapshot = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  agent: z.string(),
  state: SessionState,
  stateSince: z.number(),
  sleeping: z.boolean(),
  dangerouslySkipPermissions: z.boolean(),
  ephemeral: z.boolean(),
  isWorktree: z.boolean(),
  resumeSessionId: z.string().nullable(),
  activeAgents: z.number().int().nonnegative(),
  packs: z.array(z.object({ name: z.string(), version: z.string() })),
  pendingWakeup: PendingWakeup.nullable(),
  pendingPromptKind: z.string().nullable(),
  mergeStatus: z.string().nullable(),
  mergeReason: z.string().nullable(),
  worktreeNotice: z.string().nullable(),
  effectiveBase: z.string().nullable(),
  auditLog: z.array(z.unknown()),
}).passthrough();

/** @typedef {import('zod').infer<typeof SessionState>} SessionState */
/** @typedef {import('zod').infer<typeof SessionSnapshot>} SessionSnapshot */

module.exports = { PendingWakeup, SessionState, SessionSnapshot };
