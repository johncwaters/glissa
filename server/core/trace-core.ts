import type { TraceRecord } from '../../shared/contracts/trace.ts';
import { MAX_RAW_LINE_CHARS } from '../../shared/contracts/trace.ts';
import { firstTextBlock, parseJson, parseTimestamp } from './ingest-agent-core.ts';

const MAX_TOOL_RESULT_CHARS = 65536;

const DROPPED_LINE_TYPES = new Set([
  'agent-name',
  'ai-title',
  'atis-latch',
  'attachment',
  'bridge-session',
  'file-history-delta',
  'file-history-snapshot',
  'last-prompt',
  'mode',
  'permission-mode',
  'queue-operation',
  'system',
]);

interface TraceLineContext {
  vendorSessionId: string;
  now: number;
  agentId?: string;
  agentType?: string;
  skillToolUseIds?: ReadonlySet<string>;
}

interface TranscriptContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface TranscriptLine {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  agentId?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  sourceToolUseID?: unknown;
  subtype?: unknown;
  message?: { content?: unknown };
}

type TraceRecordBase = Pick<TraceRecord, 'ts' | 'uuid' | 'parentUuid' | 'vendorSessionId' | 'agentId' | 'agentType'>;

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function parseTranscriptLine(rawLine: string): TranscriptLine | null {
  const parsed = parseJson(rawLine);
  if (!parsed) return null;
  return parsed as TranscriptLine;
}

function contentBlocks(line: TranscriptLine): TranscriptContentBlock[] {
  const content = line.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is TranscriptContentBlock => Boolean(block) && typeof block === 'object');
}

function baseRecord(line: TranscriptLine | null, context: TraceLineContext): TraceRecordBase {
  const agentId = nonEmptyString(line?.agentId) || nonEmptyString(context.agentId);
  const agentType = nonEmptyString(context.agentType);
  return {
    ts: parseTimestamp(line?.timestamp) ?? context.now,
    uuid: nonEmptyString(line?.uuid),
    parentUuid: nonEmptyString(line?.parentUuid),
    vendorSessionId: nonEmptyString(line?.sessionId) || context.vendorSessionId,
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
  };
}

function rawRecord(rawLine: string, line: TranscriptLine | null, context: TraceLineContext): TraceRecord {
  return { ...baseRecord(line, context), kind: 'raw', line: rawLine.slice(0, MAX_RAW_LINE_CHARS) };
}

function isDroppedLine(line: TranscriptLine): boolean {
  if (line.isCompactSummary === true) return true;
  if (typeof line.type === 'string' && DROPPED_LINE_TYPES.has(line.type)) return true;
  if (line.type !== 'system') return false;
  return typeof line.subtype === 'string' && line.subtype.includes('compact');
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    const serialized = JSON.stringify(content);
    return typeof serialized === 'string' ? serialized : String(content ?? '');
  }
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object') {
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
    }
    const serialized = JSON.stringify(part);
    return typeof serialized === 'string' ? serialized : String(part ?? '');
  }).join('\n');
}

function boundedToolResult(content: unknown): { content: string; truncated: boolean } {
  const complete = textContent(content);
  if (complete.length <= MAX_TOOL_RESULT_CHARS) return { content: complete, truncated: false };
  return { content: complete.slice(0, MAX_TOOL_RESULT_CHARS), truncated: true };
}

function mapUserLine(
  rawLine: string,
  line: TranscriptLine,
  context: TraceLineContext,
): TraceRecord[] {
  const base = baseRecord(line, context);
  const content = line.message?.content;
  const blocks = contentBlocks(line);
  const toolResult = blocks.find((block) => block.type === 'tool_result');
  if (toolResult) {
    const toolUseId = nonEmptyString(toolResult.tool_use_id);
    if (!toolUseId) return [rawRecord(rawLine, line, context)];
    const bounded = boundedToolResult(toolResult.content);
    return [{
      ...base,
      kind: 'tool_result',
      toolUseId,
      content: bounded.content,
      isError: toolResult.is_error === true,
      truncated: bounded.truncated,
    }];
  }

  const text = typeof content === 'string' ? content : firstTextBlock(blocks);
  if (line.isMeta === true) {
    if (!text) return [rawRecord(rawLine, line, context)];
    const sourceToolUseId = nonEmptyString(line.sourceToolUseID);
    const launchingSkillToolUseId = sourceToolUseId && context.skillToolUseIds?.has(sourceToolUseId)
      ? sourceToolUseId
      : null;
    if (!launchingSkillToolUseId) return [{ ...base, kind: 'expansion', text }];
    return [{ ...base, kind: 'expansion', text, toolUseId: launchingSkillToolUseId }];
  }
  if (!text) return [rawRecord(rawLine, line, context)];
  if (typeof content === 'string' && /<command-name>[\s\S]*?<\/command-name>/.test(content)) {
    return [{ ...base, kind: 'expansion', text: content }];
  }
  return [{ ...base, kind: 'prompt', text }];
}

function mapAssistantLine(rawLine: string, line: TranscriptLine, context: TraceLineContext): TraceRecord[] {
  const base = baseRecord(line, context);
  const records: TraceRecord[] = [];
  for (const block of contentBlocks(line)) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      records.push({ ...base, kind: 'thinking', text: block.thinking });
      continue;
    }
    if (block.type === 'text') {
      const text = firstTextBlock([block]);
      if (text) records.push({ ...base, kind: 'assistant', text });
      continue;
    }
    if (block.type !== 'tool_use') continue;
    const toolUseId = nonEmptyString(block.id);
    const name = nonEmptyString(block.name);
    if (!toolUseId || !name) return [rawRecord(rawLine, line, context)];
    records.push({ ...base, kind: 'tool_call', toolUseId, name, input: block.input });
  }
  if (records.length === 0) return [rawRecord(rawLine, line, context)];
  return records;
}

function traceRecordsFromTranscriptLine(rawLine: string, context: TraceLineContext): TraceRecord[] {
  const line = parseTranscriptLine(rawLine);
  if (!line) return [rawRecord(rawLine, null, context)];
  if (isDroppedLine(line)) return [];
  if (line.type === 'user') return mapUserLine(rawLine, line, context);
  if (line.type === 'assistant') return mapAssistantLine(rawLine, line, context);
  return [rawRecord(rawLine, line, context)];
}

export {
  DROPPED_LINE_TYPES,
  MAX_TOOL_RESULT_CHARS,
  traceRecordsFromTranscriptLine,
};
export type { TraceLineContext };
