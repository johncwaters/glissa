import type { TraceRecord } from '#shared/contracts/trace.ts';
import { firstDetailLine, toolDetailLine } from '#shared/tool-detail.ts';

const TRACE_MAX_RESIDENT_ROWS = 5000;

type ToolCallRecord = Extract<TraceRecord, { kind: 'tool_call' }>;
type ExpansionRecord = Extract<TraceRecord, { kind: 'expansion' }>;

export interface TraceSessionSummary {
  id: string;
  name: string;
}

export interface TraceSessionOption {
  id: string;
  label: string;
}

export interface TraceViewRow {
  record: TraceRecord;
  label: string;
  isMuted: boolean;
}

export interface TraceTurn {
  head: TraceViewRow | null;
  rows: TraceViewRow[];
  hasTrimmedRows: boolean;
}

export interface TraceGrouping {
  turns: TraceTurn[];
  toolCallByUseId: Map<string, ToolCallRecord>;
}

export interface TraceTurnAppend {
  turnIndex: number;
  isNewTurn: boolean;
  head: TraceViewRow | null;
  rows: TraceViewRow[];
}

function commandName(text: string): string | null {
  const match = text.match(/<command-name>([^<]*)<\/command-name>/);
  const inner = match?.[1];
  if (inner === undefined || /[\r\n]/.test(inner)) return null;
  return inner.trim() || null;
}

function expansionName(record: ExpansionRecord, toolCallByUseId: ReadonlyMap<string, ToolCallRecord>): string {
  if (!record.toolUseId) return commandName(record.text) ?? 'context';
  const toolCall = toolCallByUseId.get(record.toolUseId);
  if (!toolCall) return 'Skill';
  return toolDetailLine(toolCall.name, toolCall.input) || toolCall.name;
}

function isTypedCommandExpansion(record: TraceRecord): boolean {
  if (record.kind !== 'expansion' || record.toolUseId) return false;
  return commandName(record.text) !== null;
}

function startsTurn(record: TraceRecord): boolean {
  if (record.kind === 'prompt' || record.kind === 'session') return true;
  return isTypedCommandExpansion(record);
}

function byteCount(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function traceRecordBody(record: TraceRecord): string {
  if (record.kind === 'prompt' || record.kind === 'expansion' || record.kind === 'thinking' || record.kind === 'assistant' || record.kind === 'notice') return record.text;
  if (record.kind === 'tool_result') return record.content;
  if (record.kind === 'raw') return record.line;
  if (record.kind === 'tool_call') return JSON.stringify(record.input, null, 2) ?? String(record.input ?? '');
  return [
    `${record.vendor} ${record.vendorSessionId}`,
    record.transcriptPath,
    record.reason ?? '',
  ].filter(Boolean).join('\n');
}

function labelWithoutTruncation(record: TraceRecord, toolCallByUseId: ReadonlyMap<string, ToolCallRecord>): string {
  if (record.kind === 'prompt') return `Prompt: ${firstDetailLine(record.text)}`;
  if (record.kind === 'thinking') return `Thinking: ${firstDetailLine(record.text)}`;
  if (record.kind === 'assistant') return `Assistant: ${firstDetailLine(record.text)}`;
  if (record.kind === 'notice') return `Notice: ${firstDetailLine(record.text)}`;
  if (record.kind === 'raw') return `Raw: ${firstDetailLine(record.line)}`;
  if (record.kind === 'session') return `Session: ${record.vendor} ${record.vendorSessionId}`;
  if (record.kind === 'expansion') return `Expansion: ${expansionName(record, toolCallByUseId)}`;
  if (record.kind === 'tool_call') {
    const detail = toolDetailLine(record.name, record.input);
    return detail ? `${record.name}: ${detail}` : record.name;
  }
  const toolName = toolCallByUseId.get(record.toolUseId)?.name ?? 'Tool';
  const errorMarker = record.isError ? ', error' : '';
  return `${toolName} result: ${byteCount(record.content)} bytes${errorMarker}`;
}

function baseTraceRecordLabel(record: TraceRecord, toolCallByUseId: ReadonlyMap<string, ToolCallRecord>): string {
  const label = labelWithoutTruncation(record, toolCallByUseId);
  if (record.truncated !== true) return label;
  return `${label}, truncated`;
}

function traceViewRow(record: TraceRecord, toolCallByUseId: ReadonlyMap<string, ToolCallRecord>): TraceViewRow {
  const baseLabel = baseTraceRecordLabel(record, toolCallByUseId);
  const agentType = record.agentType ?? null;
  return {
    record,
    label: agentType ? `[${agentType}] ${baseLabel}` : baseLabel,
    isMuted: record.kind === 'notice',
  };
}

export function createTraceGrouping(): TraceGrouping {
  return { turns: [], toolCallByUseId: new Map<string, ToolCallRecord>() };
}

export function appendTraceRecords(grouping: TraceGrouping, records: readonly TraceRecord[]): TraceTurnAppend[] {
  for (const record of records) {
    if (record.kind === 'tool_call') grouping.toolCallByUseId.set(record.toolUseId, record);
  }

  const appends: TraceTurnAppend[] = [];
  let currentTurn = grouping.turns[grouping.turns.length - 1] ?? null;
  for (const record of records) {
    const row = traceViewRow(record, grouping.toolCallByUseId);
    if (startsTurn(record)) {
      currentTurn = { head: row, rows: [], hasTrimmedRows: false };
      grouping.turns.push(currentTurn);
      appends.push({ turnIndex: grouping.turns.length - 1, isNewTurn: true, head: row, rows: [] });
      continue;
    }
    if (!currentTurn) {
      currentTurn = { head: null, rows: [], hasTrimmedRows: false };
      grouping.turns.push(currentTurn);
      appends.push({ turnIndex: grouping.turns.length - 1, isNewTurn: true, head: null, rows: [] });
    }
    currentTurn.rows.push(row);
    const turnIndex = grouping.turns.length - 1;
    const openAppend = appends[appends.length - 1];
    if (openAppend && openAppend.turnIndex === turnIndex) {
      openAppend.rows.push(row);
      continue;
    }
    appends.push({ turnIndex, isNewTurn: false, head: null, rows: [row] });
  }
  return appends;
}

export interface TracePrepend {
  newTurns: TraceTurn[];
  mergedHead: TraceViewRow | null;
  mergedRows: TraceViewRow[];
}

export function prependTraceRecords(grouping: TraceGrouping, records: readonly TraceRecord[]): TracePrepend {
  const earlier = createTraceGrouping();
  appendTraceRecords(earlier, records);
  for (const [toolUseId, toolCall] of earlier.toolCallByUseId) {
    if (!grouping.toolCallByUseId.has(toolUseId)) grouping.toolCallByUseId.set(toolUseId, toolCall);
  }
  const lastEarlierTurn = earlier.turns[earlier.turns.length - 1];
  const firstResidentTurn = grouping.turns[0];
  const isBoundaryTurnSplit = !!lastEarlierTurn && !!firstResidentTurn && !firstResidentTurn.head;
  const mergedHead = isBoundaryTurnSplit ? lastEarlierTurn.head : null;
  const mergedRows = isBoundaryTurnSplit ? lastEarlierTurn.rows : [];
  if (isBoundaryTurnSplit) {
    earlier.turns.pop();
    firstResidentTurn.head = mergedHead;
    firstResidentTurn.rows = [...mergedRows, ...firstResidentTurn.rows];
  }
  grouping.turns = [...earlier.turns, ...grouping.turns];
  return { newTurns: earlier.turns, mergedHead, mergedRows };
}

function turnRowCount(turn: TraceTurn): number {
  return turn.rows.length + (turn.head ? 1 : 0);
}

export function traceResidentRowCount(grouping: TraceGrouping): number {
  let residentRowCount = 0;
  for (const turn of grouping.turns) residentRowCount += turnRowCount(turn);
  return residentRowCount;
}

function forgetRowToolCalls(grouping: TraceGrouping, rows: readonly TraceViewRow[]): void {
  for (const row of rows) {
    if (row.record.kind === 'tool_call') grouping.toolCallByUseId.delete(row.record.toolUseId);
  }
}

function forgetTurnToolCalls(grouping: TraceGrouping, turn: TraceTurn): void {
  forgetRowToolCalls(grouping, turn.head ? [turn.head, ...turn.rows] : turn.rows);
}

export interface TraceTrim {
  droppedTurnCount: number;
  droppedRowCount: number;
}

function dropOldestRowsOfFirstTurn(grouping: TraceGrouping, excessRowCount: number): number {
  const oldestTurn = grouping.turns[0];
  if (!oldestTurn) return 0;
  const droppedRowCount = Math.min(excessRowCount, oldestTurn.rows.length);
  if (droppedRowCount <= 0) return 0;
  forgetRowToolCalls(grouping, oldestTurn.rows.slice(0, droppedRowCount));
  oldestTurn.rows = oldestTurn.rows.slice(droppedRowCount);
  oldestTurn.hasTrimmedRows = true;
  return droppedRowCount;
}

export function trimTraceGrouping(grouping: TraceGrouping, maxResidentRows = TRACE_MAX_RESIDENT_ROWS): TraceTrim {
  let residentRowCount = traceResidentRowCount(grouping);
  let droppedTurnCount = 0;
  while (residentRowCount > maxResidentRows && droppedTurnCount < grouping.turns.length - 1) {
    const oldestKeptTurn = grouping.turns[droppedTurnCount];
    if (!oldestKeptTurn) break;
    residentRowCount -= turnRowCount(oldestKeptTurn);
    forgetTurnToolCalls(grouping, oldestKeptTurn);
    droppedTurnCount += 1;
  }
  if (droppedTurnCount > 0) grouping.turns = grouping.turns.slice(droppedTurnCount);
  if (residentRowCount <= maxResidentRows) return { droppedTurnCount, droppedRowCount: 0 };
  return { droppedTurnCount, droppedRowCount: dropOldestRowsOfFirstTurn(grouping, residentRowCount - maxResidentRows) };
}

export function traceSessionOptions(sessions: readonly TraceSessionSummary[]): TraceSessionOption[] {
  const options: TraceSessionOption[] = [];
  const seenIds = new Set<string>();
  for (const session of sessions) {
    if (!session.id || !session.name || seenIds.has(session.id)) continue;
    seenIds.add(session.id);
    options.push({ id: session.id, label: session.name });
  }
  return options;
}

export function resolveTraceSessionId(
  options: readonly TraceSessionOption[],
  preselectedId: string | null,
  currentId: string | null,
  canFallBackToFirst = true,
): string | null {
  if (preselectedId && options.some((option) => option.id === preselectedId)) return preselectedId;
  if (currentId && options.some((option) => option.id === currentId)) return currentId;
  if (!canFallBackToFirst) return null;
  return options[0]?.id ?? null;
}

export type TracePageDirection = 'tail' | 'earlier' | 'forward';

export interface TraceRequest {
  id: string;
  direction: TracePageDirection;
  after: number;
  endingAt?: number | 'tail';
}

export interface TraceRequestInputs {
  selectedSessionId: string | null;
  isPanelVisible: boolean;
  hasPendingRequest: boolean;
  hasLoadedOnce: boolean;
  nextOffset: number;
}

export function nextTraceRequest(inputs: TraceRequestInputs): TraceRequest | null {
  if (!inputs.selectedSessionId || !inputs.isPanelVisible || inputs.hasPendingRequest) return null;
  if (!inputs.hasLoadedOnce) return { id: inputs.selectedSessionId, direction: 'tail', after: 0, endingAt: 'tail' };
  return { id: inputs.selectedSessionId, direction: 'forward', after: inputs.nextOffset };
}

export interface EarlierTraceRequestInputs {
  selectedSessionId: string | null;
  hasPendingRequest: boolean;
  hasLoadedOnce: boolean;
  hasDroppedEarliestRows: boolean;
  firstOffset: number;
  residentRowCount: number;
}

export function hasEarlierTracePages(inputs: EarlierTraceRequestInputs, maxResidentRows = TRACE_MAX_RESIDENT_ROWS): boolean {
  if (!inputs.selectedSessionId || !inputs.hasLoadedOnce || inputs.hasDroppedEarliestRows) return false;
  if (inputs.residentRowCount >= maxResidentRows) return false;
  return inputs.firstOffset > 0;
}

export function earlierTraceRequest(inputs: EarlierTraceRequestInputs, maxResidentRows = TRACE_MAX_RESIDENT_ROWS): TraceRequest | null {
  if (!hasEarlierTracePages(inputs, maxResidentRows) || inputs.hasPendingRequest || !inputs.selectedSessionId) return null;
  return { id: inputs.selectedSessionId, direction: 'earlier', after: 0, endingAt: inputs.firstOffset };
}

export interface TraceResidentWindow {
  sessionId: string;
  firstOffset: number;
  nextOffset: number;
  hasLoadedOnce: boolean;
}

export type TraceReplyOutcome = 'ignore' | 'stale' | 'reset' | 'seed' | 'append' | 'prepend';

export interface TraceReplyInputs {
  pendingRequest: TraceRequest | null;
  resident: TraceResidentWindow | null;
  reply: { id: string; start: number; next: number; reset: boolean };
}

export function traceReplyOutcome(inputs: TraceReplyInputs): TraceReplyOutcome {
  const { pendingRequest, resident, reply } = inputs;
  if (!pendingRequest || pendingRequest.id !== reply.id) return 'ignore';
  if (!resident || resident.sessionId !== reply.id) return 'stale';
  if (reply.reset || reply.next < reply.start) return 'reset';
  if (pendingRequest.direction === 'tail') return resident.hasLoadedOnce ? 'stale' : 'seed';
  if (pendingRequest.direction === 'earlier') {
    if (resident.firstOffset !== pendingRequest.endingAt) return 'stale';
    return reply.next === pendingRequest.endingAt ? 'prepend' : 'reset';
  }
  if (resident.nextOffset !== pendingRequest.after) return 'stale';
  return reply.start === pendingRequest.after ? 'append' : 'reset';
}

export interface TraceRebuildInputs {
  hasSelectionChanged: boolean;
  isRenderedTraceStale: boolean;
  hasRenderedOnce: boolean;
}

export function shouldRebuildTraceView(inputs: TraceRebuildInputs): boolean {
  return inputs.hasSelectionChanged || inputs.isRenderedTraceStale || !inputs.hasRenderedOnce;
}

export function traceEmptyState(session: TraceSessionOption | null): string {
  if (!session) return 'No sessions are available.';
  return `No trace has been recorded for ${session.label}.`;
}
