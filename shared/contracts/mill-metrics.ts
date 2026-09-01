import { z } from 'zod';

const MAX_PACK_REL_PATH_CHARS = 512;
const MAX_PACK_FILES_PER_SESSION = 300;

const MillMetricEvent = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('pack-delivered'),
    ts: z.number(),
    sessionId: z.string().min(1),
    pack: z.string().min(1),
    version: z.string(),
    tokenEstimate: z.number().nullable(),
    agent: z.string().min(1),
    readDetection: z.enum(['available', 'unavailable']),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('pack-read'),
    ts: z.number(),
    sessionId: z.string().min(1),
    pack: z.string().min(1),
    relPath: z.string().min(1).max(MAX_PACK_REL_PATH_CHARS),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('prompt'),
    ts: z.number(),
    sessionId: z.string().min(1),
    promptClass: z.enum(['interruption', 'answer', 'followup', 'ambiguous']),
    state: z.string(),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('session-end'),
    ts: z.number(),
    sessionId: z.string().min(1),
    disposition: z.enum(['user-kill', 'natural']).nullable(),
    finalState: z.string(),
    transition: z.string(),
  }),
]);

const MillMetricPackRecord = z.object({
  name: z.string().min(1),
  version: z.string(),
  tokenEstimate: z.number().nullable(),
  filesRead: z.number().int().nonnegative(),
  files: z.array(z.string().min(1).max(MAX_PACK_REL_PATH_CHARS)).max(MAX_PACK_FILES_PER_SESSION).default([]),
  filesDropped: z.number().int().nonnegative().default(0),
  opened: z.boolean(),
  measurable: z.boolean().optional(),
});

const MillMetricSessionRecord = z.object({
  sessionId: z.string().min(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  agent: z.string().min(1),
  readDetection: z.enum(['available', 'unavailable']),
  disposition: z.enum(['user-kill', 'natural']).nullable(),
  finalState: z.string().nullable(),
  tokens: z.number().nullable(),
  costUSD: z.number().nullable(),
  resumeSessionId: z.string().nullable(),
  prompts: z.object({
    interruption: z.number().int().nonnegative(),
    answer: z.number().int().nonnegative(),
    followup: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
  }),
  packs: z.array(MillMetricPackRecord),
});

const MillMetricStore = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  sessions: z.array(MillMetricSessionRecord),
});

export type MillMetricPromptClass = 'interruption' | 'answer' | 'followup' | 'ambiguous';
export type MillMetricReadDetection = 'available' | 'unavailable';
export type MillMetricDisposition = 'user-kill' | 'natural';
export type MillMetricPromptCounts = Record<MillMetricPromptClass, number>;
export type MillMetricPack = z.infer<typeof MillMetricPackRecord>;
export type MillMetricSession = z.infer<typeof MillMetricSessionRecord>;

export {
  MAX_PACK_FILES_PER_SESSION,
  MAX_PACK_REL_PATH_CHARS,
  MillMetricEvent,
  MillMetricPackRecord,
  MillMetricSessionRecord,
  MillMetricStore,
};
