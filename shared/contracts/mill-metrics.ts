const zod: typeof import('zod') = require('zod');

const { z } = zod;

// A pack read is keyed by its path relative to the delivered pack dir, and one session's reads are
// unbounded input from the agent, so both the key and the set are capped at ingest and in the shape.
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
  // Absent on records written before per-pack measurability existed, where the session-wide
  // readDetection is the only answer available.
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

// A CommonJS .ts module declares no exports to TypeScript, so the shapes and the module surface are
// published as global types: that is what makes a cross-file require() checked rather than `any`.
declare global {
  type MillMetricPromptClass = 'interruption' | 'answer' | 'followup' | 'ambiguous';
  type MillMetricReadDetection = 'available' | 'unavailable';
  type MillMetricDisposition = 'user-kill' | 'natural';
  type MillMetricPromptCounts = Record<MillMetricPromptClass, number>;
  type MillMetricPack = ReturnType<typeof MillMetricPackRecord.parse>;
  type MillMetricSession = ReturnType<typeof MillMetricSessionRecord.parse>;

  type MillMetricsContracts = {
    MAX_PACK_FILES_PER_SESSION: typeof MAX_PACK_FILES_PER_SESSION;
    MAX_PACK_REL_PATH_CHARS: typeof MAX_PACK_REL_PATH_CHARS;
    MillMetricEvent: typeof MillMetricEvent;
    MillMetricPackRecord: typeof MillMetricPackRecord;
    MillMetricSessionRecord: typeof MillMetricSessionRecord;
    MillMetricStore: typeof MillMetricStore;
  };
}

module.exports = {
  MAX_PACK_FILES_PER_SESSION,
  MAX_PACK_REL_PATH_CHARS,
  MillMetricEvent,
  MillMetricPackRecord,
  MillMetricSessionRecord,
  MillMetricStore,
} satisfies MillMetricsContracts;
