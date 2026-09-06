import { z } from 'zod';

export const MAX_RAW_LINE_CHARS = 4000;

const TraceRecordBase = z.object({
  ts: z.number().finite(),
  uuid: z.string().nullable(),
  parentUuid: z.string().nullable(),
  vendorSessionId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  agentType: z.string().min(1).optional(),
  transcriptOffset: z.number().int().nonnegative().optional(),
});

export const TraceRecord = z.discriminatedUnion('kind', [
  TraceRecordBase.extend({
    kind: z.literal('prompt'),
    text: z.string(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('expansion'),
    text: z.string(),
    toolUseId: z.string().min(1).optional(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('thinking'),
    text: z.string(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('assistant'),
    text: z.string(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('tool_call'),
    toolUseId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('tool_result'),
    toolUseId: z.string().min(1),
    content: z.string(),
    isError: z.boolean(),
    truncated: z.boolean(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('session'),
    vendor: z.string().min(1),
    transcriptPath: z.string().min(1),
    reason: z.string().min(1).optional(),
  }),
  TraceRecordBase.extend({
    kind: z.literal('notice'),
    text: z.string().max(MAX_RAW_LINE_CHARS),
  }),
  TraceRecordBase.extend({
    kind: z.literal('raw'),
    line: z.string().max(MAX_RAW_LINE_CHARS),
  }),
]);

export type TraceRecord = z.infer<typeof TraceRecord>;

export const TraceCheckpoint = z.object({
  transcriptPath: z.string().min(1),
  vendorSessionId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  ingestedSubagentPaths: z.array(z.string().min(1)),
  offsetByTranscriptPath: z.record(z.string().min(1), z.number().int().nonnegative()).default({}),
});

export type TraceCheckpoint = z.infer<typeof TraceCheckpoint>;
