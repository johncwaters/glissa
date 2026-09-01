import { z } from 'zod';

export const HookPayload = z.record(z.string(), z.unknown());

export const HookEnvelope = z.object({
  glissaId: z.string().min(1),
  event: z.string().min(1),
  token: z.string().nullable().optional(),
  payload: HookPayload,
});

export const UserHook = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  event: z.string().min(1),
  matcher: z.string().optional(),
  type: z.enum(['command', 'http']),
  command: z.string().optional(),
  url: z.string().optional(),
  timeout: z.number().int().positive().optional(),
  enabled: z.boolean(),
  projects: z.array(z.string()).optional(),
}).passthrough();

export type HookPayload = z.infer<typeof HookPayload>;
export type UserHook = z.infer<typeof UserHook>;
export type HookEnvelope = z.infer<typeof HookEnvelope>;
