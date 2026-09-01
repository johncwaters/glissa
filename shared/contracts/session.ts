import { z } from 'zod';
import { STATES } from '../states.ts';

export const SessionState = z.enum(STATES);
export const PendingWakeup = z.object({
  at: z.number().finite().nullable(),
  kind: z.string(),
  reason: z.string().nullable(),
}).passthrough();

export const SessionSnapshot = z.object({
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
  mergeReason: z.string().nullable(),
  worktreeNotice: z.string().nullable(),
  effectiveBase: z.string().nullable(),
  auditLog: z.array(z.unknown()),
}).passthrough();

export type SessionState = z.infer<typeof SessionState>;
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;
export type PendingWakeup = z.infer<typeof PendingWakeup>;
