'use strict';

const { z } = require('zod');

const HookPayload = z.record(z.string(), z.unknown());

const HookEnvelope = z.object({
  glissaId: z.string().min(1),
  event: z.string().min(1),
  token: z.string().nullable().optional(),
  payload: HookPayload,
});

// An operator-defined hook record in its FULL shape, as the Hooks tab sends one and the report gives
// one back (session/core/user-hooks-core.js owns the semantic checks). Deliberately NOT what
// config.json is parsed against: a stored record is validated loosely there and judged by the core at
// read time, so one hand edit missing a field cannot fail the whole config load.
const UserHook = z.object({
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

/** @typedef {import('zod').infer<typeof HookPayload>} HookPayload */
/** @typedef {import('zod').infer<typeof UserHook>} UserHook */
/** @typedef {import('zod').infer<typeof HookEnvelope>} HookEnvelope */

module.exports = { HookPayload, HookEnvelope, UserHook };
