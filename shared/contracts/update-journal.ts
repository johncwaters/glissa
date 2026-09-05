import { z } from 'zod';

export const UpdateChannel = z.enum(['release', 'main']);
export const UpdateRunState = z.enum(['idle', 'running', 'staged', 'succeeded', 'failed', 'discarded', 'interrupted']);
export const UpdateStepId = z.enum(['fetch', 'stage', 'install', 'link-deps', 'build']);
export const UpdateStepStatus = z.enum(['pending', 'running', 'succeeded', 'failed']);

export const UpdateJournalStep = z.object({
  id: UpdateStepId,
  status: UpdateStepStatus,
  startedAt: z.number().finite().nullable(),
  finishedAt: z.number().finite().nullable(),
  outputTail: z.array(z.string()),
}).strict();

export const UpdateJournal = z.object({
  state: UpdateRunState,
  fromSha: z.string().nullable(),
  toSha: z.string().nullable(),
  toVersion: z.string().nullable(),
  channel: UpdateChannel,
  steps: z.array(UpdateJournalStep),
  activeStep: UpdateStepId.nullable(),
  reason: z.string().nullable(),
  startedAt: z.number().finite().nullable(),
  finishedAt: z.number().finite().nullable(),
}).strict();

export const UpdateJournalSummary = UpdateJournal.pick({
  state: true,
  activeStep: true,
  reason: true,
  startedAt: true,
  finishedAt: true,
});

export type UpdateChannel = z.infer<typeof UpdateChannel>;
export type UpdateJournal = z.infer<typeof UpdateJournal>;
export type UpdateJournalStep = z.infer<typeof UpdateJournalStep>;
export type UpdateJournalSummary = z.infer<typeof UpdateJournalSummary>;
export type UpdateRunState = z.infer<typeof UpdateRunState>;
export type UpdateStepId = z.infer<typeof UpdateStepId>;
export type UpdateStepStatus = z.infer<typeof UpdateStepStatus>;
