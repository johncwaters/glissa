import type { TraceRecord } from '../../shared/contracts/trace.ts';
import { MAX_RAW_LINE_CHARS } from '../../shared/contracts/trace.ts';
import { firstTextBlock, parseJson, parseTimestamp } from './ingest-agent-core.ts';

const MAX_TRACE_BODY_CHARS = 65536;
const MAX_TRACE_CALL_INPUT_CHARS = MAX_TRACE_BODY_CHARS * 2;

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
  const isCut = rawLine.length > MAX_RAW_LINE_CHARS;
  return {
    ...baseRecord(line, context),
    kind: 'raw',
    line: rawLine.slice(0, MAX_RAW_LINE_CHARS),
    ...(isCut ? { truncated: true } : {}),
  };
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

function boundedText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_TRACE_BODY_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_TRACE_BODY_CHARS), truncated: true };
}

function boundedTextFields(value: string): { text: string; truncated?: true } {
  const bounded = boundedText(value);
  if (!bounded.truncated) return { text: bounded.text };
  return { text: bounded.text, truncated: true };
}

function serializedInputText(input: unknown): string {
  const serialized = JSON.stringify(input);
  if (typeof serialized === 'string') return serialized;
  return String(input);
}

function boundedInputProperties(input: Record<string, unknown>): { input: Record<string, unknown>; hasCutProperty: boolean } {
  const boundedEntries = Object.entries(input).map(([propertyName, propertyValue]) => {
    if (typeof propertyValue !== 'string') return { propertyName, boundedValue: propertyValue as unknown, isCut: false };
    const bounded = boundedText(propertyValue);
    return { propertyName, boundedValue: bounded.text as unknown, isCut: bounded.truncated };
  });
  return {
    input: Object.fromEntries(boundedEntries.map((entry) => [entry.propertyName, entry.boundedValue])),
    hasCutProperty: boundedEntries.some((entry) => entry.isCut),
  };
}

function boundedToolCallInput(input: unknown): { input: unknown; truncated?: true } {
  if (typeof input === 'string') {
    const bounded = boundedText(input);
    if (!bounded.truncated) return { input };
    return { input: bounded.text, truncated: true };
  }
  if (!input || typeof input !== 'object') return { input };
  const bounded = Array.isArray(input)
    ? { input: input as unknown, hasCutProperty: false }
    : boundedInputProperties(input as Record<string, unknown>);
  const serialized = serializedInputText(bounded.input);
  if (serialized.length > MAX_TRACE_CALL_INPUT_CHARS) {
    return { input: serialized.slice(0, MAX_TRACE_BODY_CHARS), truncated: true };
  }
  if (!bounded.hasCutProperty) return { input };
  return { input: bounded.input, truncated: true };
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
    const bounded = boundedText(textContent(toolResult.content));
    return [{
      ...base,
      kind: 'tool_result',
      toolUseId,
      content: bounded.text,
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
    if (!launchingSkillToolUseId) return [{ ...base, kind: 'expansion', ...boundedTextFields(text) }];
    return [{ ...base, kind: 'expansion', toolUseId: launchingSkillToolUseId, ...boundedTextFields(text) }];
  }
  if (!text) return [rawRecord(rawLine, line, context)];
  if (typeof content === 'string' && /<command-name>[\s\S]*?<\/command-name>/.test(content)) {
    return [{ ...base, kind: 'expansion', ...boundedTextFields(content) }];
  }
  return [{ ...base, kind: 'prompt', ...boundedTextFields(text) }];
}

function mapAssistantLine(rawLine: string, line: TranscriptLine, context: TraceLineContext): TraceRecord[] {
  const base = baseRecord(line, context);
  const records: TraceRecord[] = [];
  let hasSkippedThinkingBlock = false;
  for (const block of contentBlocks(line)) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      if (block.thinking.length === 0) {
        hasSkippedThinkingBlock = true;
        continue;
      }
      records.push({ ...base, kind: 'thinking', ...boundedTextFields(block.thinking) });
      continue;
    }
    if (block.type === 'text') {
      const text = firstTextBlock([block]);
      if (text) {
        records.push({ ...base, kind: 'assistant', ...boundedTextFields(text) });
      }
      continue;
    }
    if (block.type !== 'tool_use') continue;
    const toolUseId = nonEmptyString(block.id);
    const name = nonEmptyString(block.name);
    if (!toolUseId || !name) return [rawRecord(rawLine, line, context)];
    records.push({ ...base, kind: 'tool_call', toolUseId, name, ...boundedToolCallInput(block.input) });
  }
  if (records.length === 0 && hasSkippedThinkingBlock) return [];
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
  MAX_TRACE_BODY_CHARS,
  traceRecordsFromTranscriptLine,
};
export type { TraceLineContext };
