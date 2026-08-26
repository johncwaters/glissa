'use strict';

const { z } = require('zod');

const HookPayload = z.record(z.string(), z.unknown());

const HookEnvelope = z.object({
  glissaId: z.string().min(1),
  event: z.string().min(1),
  token: z.string().nullable().optional(),
  payload: HookPayload,
});

/** @typedef {import('zod').infer<typeof HookPayload>} HookPayload */
/** @typedef {import('zod').infer<typeof HookEnvelope>} HookEnvelope */

module.exports = { HookPayload, HookEnvelope };
