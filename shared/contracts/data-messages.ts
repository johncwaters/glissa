import { z } from 'zod';

export const VIEWER_MIN_COLS = 1;
export const VIEWER_MAX_COLS = 500;
export const VIEWER_MIN_ROWS = 1;
export const VIEWER_MAX_ROWS = 200;

const viewerCols = z.number().int().min(VIEWER_MIN_COLS).max(VIEWER_MAX_COLS);
const viewerRows = z.number().int().min(VIEWER_MIN_ROWS).max(VIEWER_MAX_ROWS);

export const DataClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({ type: z.literal('claim'), cols: viewerCols, rows: viewerRows }),
  z.object({ type: z.literal('unview') }),
]);
export type DataClientMessage = z.infer<typeof DataClientMessage>;

export const PtySizeFrame = z.object({
  type: z.literal('pty-size'),
  cols: viewerCols,
  rows: viewerRows,
  seq: z.number().int().nonnegative(),
});
export type PtySizeFrame = z.infer<typeof PtySizeFrame>;

function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseDataClientMessage(raw: string): DataClientMessage | null {
  const parsed = DataClientMessage.safeParse(decodeJson(raw));
  if (!parsed.success) return null;
  return parsed.data;
}

export function parsePtySizeFrame(raw: string): PtySizeFrame | null {
  const parsed = PtySizeFrame.safeParse(decodeJson(raw));
  if (!parsed.success) return null;
  return parsed.data;
}
