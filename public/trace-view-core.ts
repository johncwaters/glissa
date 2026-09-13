import type { TraceRecord } from '#shared/contracts/trace.ts';
import { firstDetailLine, toolDetailLine } from '#shared/tool-detail.ts';
import { formatClockOffset } from './radar-core.ts';

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
  kind: TraceRecord['kind'];
  tag: string;
  text: string;
  tone: 'default' | 'error' | 'muted';
  badges: string[];
}

export interface TraceTurn {
  head: TraceViewRow | null;
  rows: TraceViewRow[];
  hasTrimmedRows: boolean;
  startedAt: number | null;
  metrics: TraceTurnMetrics;
}

export interface TraceTurnMetrics {
  rowCount: number;
  toolCallCount: number;
  errorCount: number;
  resultBytes: number;
}

export interface TraceGrouping {
  turns: TraceTurn[];
  toolCallByUseId: Map<string, ToolCallRecord>;
  unresolvedToolUseCounts: Map<string, number>;
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
  if (!toolCall) return 'expansion';
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

const TRACE_TAG_BY_KIND: Record<TraceRecord['kind'], string> = {
  prompt: 'PROMPT',
  expansion: 'EXPANSION',
  thinking: 'THINKING',
  assistant: 'ASSISTANT',
  tool_call: 'TOOL',
  tool_result: 'RESULT',
  session: 'SESSION',
  notice: 'NOTICE',
  raw: 'RAW',
};

export const TRACE_FILTERABLE_KINDS: readonly { kind: TraceRecord['kind']; label: string }[] = [
  { kind: 'thinking', label: 'Thinking' },
  { kind: 'tool_result', label: 'Tool result' },
  { kind: 'raw', label: 'Raw' },
];

interface TraceLabelParts {
  prefix: string;
  text: string;
}

function traceLabelParts(record: TraceRecord, toolCallByUseId: ReadonlyMap<string, ToolCallRecord>): TraceLabelParts {
  if (record.kind === 'prompt') return { prefix: 'Prompt: ', text: firstDetailLine(record.text) };
  if (record.kind === 'thinking') return { prefix: 'Thinking: ', text: firstDetailLine(record.text) };
  if (record.kind === 'assistant') return { prefix: 'Assistant: ', text: firstDetailLine(record.text) };
  if (record.kind === 'notice') return { prefix: 'Notice: ', text: firstDetailLine(record.text) };
  if (record.kind === 'raw') return { prefix: 'Raw: ', text: firstDetailLine(record.line) };
  if (record.kind === 'session') return { prefix: 'Session: ', text: `${record.vendor} ${record.vendorSessionId}` };
  if (record.kind === 'expansion') return { prefix: 'Expansion: ', text: expansionName(record, toolCallByUseId) };
  if (record.kind === 'tool_call') {
    const detail = toolDetailLine(record.name, record.input);
    if (!detail) return { prefix: '', text: record.name };
    return { prefix: `${record.name}: `, text: detail };
  }
  const toolName = toolCallByUseId.get(record.toolUseId)?.name ?? 'Tool';
  return { prefix: `${toolName} result: `, text: `${byteCount(record.content)} bytes` };
}

function traceAgentPrefix(record: TraceRecord): string {
  if (!record.agentType) return '';
  const agentIdSuffix = record.agentId ? ` ${record.agentId.slice(-6)}` : '';
  return `[${record.agentType}${agentIdSuffix}] `;
}

export function traceRowParts(record: TraceRecord, toolCallByUseId: ReadonlyMap<string, ToolCallRecord>): Omit<TraceViewRow, 'record'> {
  const labelParts = traceLabelParts(record, toolCallByUseId);
  const agentPrefix = traceAgentPrefix(record);
  const renderedText = record.kind === 'tool_call' || record.kind === 'tool_result'
    ? `${labelParts.prefix}${labelParts.text}`
    : labelParts.text;
  const badges: string[] = [];
  let tone: TraceViewRow['tone'] = record.kind === 'notice' ? 'muted' : 'default';
  if (record.kind === 'tool_result' && record.isError) {
    tone = 'error';
    badges.push('error');
  }
  if (record.truncated === true) {
    if (tone !== 'error') tone = 'muted';
    badges.push('truncated');
  }
  if (record.kind === 'tool_result') {
    const toolCall = toolCallByUseId.get(record.toolUseId);
    const latencyMs = toolCall ? record.ts - toolCall.ts : Number.NaN;
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      badges.push(latencyMs > 1000 ? `${(latencyMs / 1000).toFixed(1)}s` : `${Math.round(latencyMs)}ms`);
    }
  }
  return {
    kind: record.kind,
    tag: TRACE_TAG_BY_KIND[record.kind],
    text: `${agentPrefix}${renderedText}`,
    tone,
    badges,
  };
}

function traceViewRow(record: TraceRecord, toolCallByUseId: ReadonlyMap<string, ToolCallRecord>): TraceViewRow {
  return { record, ...traceRowParts(record, toolCallByUseId) };
}

function referencedToolUseId(record: TraceRecord): string | null {
  if (record.kind !== 'tool_result' && record.kind !== 'expansion') return null;
  return record.toolUseId || null;
}

function unresolvedToolUseId(record: TraceRecord, toolCallByUseId: ReadonlyMap<string, ToolCallRecord>): string | null {
  const toolUseId = referencedToolUseId(record);
  if (!toolUseId || toolCallByUseId.has(toolUseId)) return null;
  return toolUseId;
}

function retainUnresolvedToolUseId(unresolvedToolUseCounts: Map<string, number>, toolUseId: string, referencingRowCount = 1): void {
  unresolvedToolUseCounts.set(toolUseId, (unresolvedToolUseCounts.get(toolUseId) ?? 0) + referencingRowCount);
}

function releaseUnresolvedToolUseId(unresolvedToolUseCounts: Map<string, number>, toolUseId: string): void {
  const remainingReferencingRowCount = (unresolvedToolUseCounts.get(toolUseId) ?? 0) - 1;
  if (remainingReferencingRowCount > 0) {
    unresolvedToolUseCounts.set(toolUseId, remainingReferencingRowCount);
    return;
  }
  unresolvedToolUseCounts.delete(toolUseId);
}

function relabelRowsOfToolUseIds(grouping: TraceGrouping, toolUseIds: ReadonlySet<string>): void {
  if (toolUseIds.size === 0) return;
  for (const turn of grouping.turns) {
    for (let rowIndex = 0; rowIndex < turn.rows.length; rowIndex += 1) {
      const row = turn.rows[rowIndex];
      const toolUseId = referencedToolUseId(row.record);
      if (!toolUseId || !toolUseIds.has(toolUseId)) continue;
      turn.rows[rowIndex] = traceViewRow(row.record, grouping.toolCallByUseId);
    }
  }
}

export function createTraceGrouping(): TraceGrouping {
  return { turns: [], toolCallByUseId: new Map<string, ToolCallRecord>(), unresolvedToolUseCounts: new Map<string, number>() };
}

export function traceTurnDurationMs(turn: TraceTurn): number {
  if (turn.startedAt === null) return 0;
  let finishedAtMs = turn.head?.record.ts ?? turn.startedAt;
  for (const row of turn.rows) finishedAtMs = Math.max(finishedAtMs, row.record.ts);
  return Math.max(0, finishedAtMs - turn.startedAt);
}

export function formatTurnMetrics(turn: TraceTurn): string {
  const { rowCount, toolCallCount, errorCount, resultBytes } = turn.metrics;
  const rows = `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`;
  const tools = `${toolCallCount} ${toolCallCount === 1 ? 'tool' : 'tools'}`;
  const errors = `${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`;
  const bytes = resultBytes < 1024 ? `${resultBytes} B` : `${(resultBytes / 1024).toFixed(1)} KB`;
  const durationText = formatClockOffset(traceTurnDurationMs(turn));
  return `${rows}, ${tools}, ${errors}, ${bytes}, ${durationText}`;
}

function emptyTraceTurnMetrics(): TraceTurnMetrics {
  return { rowCount: 0, toolCallCount: 0, errorCount: 0, resultBytes: 0 };
}

function updateTraceTurnMetrics(turn: TraceTurn, row: TraceViewRow, direction: 1 | -1): void {
  turn.metrics.rowCount += direction;
  if (row.record.kind === 'tool_call') turn.metrics.toolCallCount += direction;
  if (row.record.kind !== 'tool_result') return;
  turn.metrics.resultBytes += byteCount(row.record.content) * direction;
  if (row.record.isError) turn.metrics.errorCount += direction;
}

export function appendTraceRecords(grouping: TraceGrouping, records: readonly TraceRecord[]): TraceTurnAppend[] {
  for (const record of records) {
    if (record.kind === 'tool_call') grouping.toolCallByUseId.set(record.toolUseId, record);
  }

  const appends: TraceTurnAppend[] = [];
  let currentTurn = grouping.turns[grouping.turns.length - 1] ?? null;
  for (const record of records) {
    const unresolvedToolUseIdValue = unresolvedToolUseId(record, grouping.toolCallByUseId);
    if (unresolvedToolUseIdValue) retainUnresolvedToolUseId(grouping.unresolvedToolUseCounts, unresolvedToolUseIdValue);
    const row = traceViewRow(record, grouping.toolCallByUseId);
    if (startsTurn(record)) {
      currentTurn = { head: row, rows: [], hasTrimmedRows: false, startedAt: record.ts, metrics: emptyTraceTurnMetrics() };
      updateTraceTurnMetrics(currentTurn, row, 1);
      grouping.turns.push(currentTurn);
      appends.push({ turnIndex: grouping.turns.length - 1, isNewTurn: true, head: row, rows: [] });
      continue;
    }
    if (!currentTurn) {
      currentTurn = { head: null, rows: [], hasTrimmedRows: false, startedAt: record.ts, metrics: emptyTraceTurnMetrics() };
      grouping.turns.push(currentTurn);
      appends.push({ turnIndex: grouping.turns.length - 1, isNewTurn: true, head: null, rows: [] });
    }
    currentTurn.rows.push(row);
    updateTraceTurnMetrics(currentTurn, row, 1);
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
  needsRerender: boolean;
}

export function prependTraceRecords(grouping: TraceGrouping, records: readonly TraceRecord[]): TracePrepend {
  const earlier = createTraceGrouping();
  appendTraceRecords(earlier, records);
  const newlyMergedToolUseIds = new Set<string>();
  for (const [toolUseId, toolCall] of earlier.toolCallByUseId) {
    if (grouping.toolCallByUseId.has(toolUseId)) continue;
    grouping.toolCallByUseId.set(toolUseId, toolCall);
    newlyMergedToolUseIds.add(toolUseId);
  }
  const newlyResolvedToolUseIds = new Set<string>();
  for (const toolUseId of newlyMergedToolUseIds) {
    if (!grouping.unresolvedToolUseCounts.delete(toolUseId)) continue;
    newlyResolvedToolUseIds.add(toolUseId);
  }
  for (const [toolUseId, referencingRowCount] of earlier.unresolvedToolUseCounts) {
    if (grouping.toolCallByUseId.has(toolUseId)) continue;
    retainUnresolvedToolUseId(grouping.unresolvedToolUseCounts, toolUseId, referencingRowCount);
  }
  const lastEarlierTurn = earlier.turns[earlier.turns.length - 1];
  const firstResidentTurn = grouping.turns[0];
  const isBoundaryTurnSplit = !!lastEarlierTurn && !!firstResidentTurn && !firstResidentTurn.head;
  const mergedHead = isBoundaryTurnSplit ? lastEarlierTurn.head : null;
  const mergedRows = isBoundaryTurnSplit ? lastEarlierTurn.rows : [];
  if (isBoundaryTurnSplit) {
    earlier.turns.pop();
    const earlierStartedAt = lastEarlierTurn.startedAt;
    const residentStartedAt = firstResidentTurn.startedAt;
    if (earlierStartedAt !== null && (residentStartedAt === null || earlierStartedAt < residentStartedAt)) {
      firstResidentTurn.startedAt = lastEarlierTurn.startedAt;
    }
    firstResidentTurn.head = mergedHead;
    firstResidentTurn.rows = [...mergedRows, ...firstResidentTurn.rows];
    firstResidentTurn.metrics = {
      rowCount: lastEarlierTurn.metrics.rowCount + firstResidentTurn.metrics.rowCount,
      toolCallCount: lastEarlierTurn.metrics.toolCallCount + firstResidentTurn.metrics.toolCallCount,
      errorCount: lastEarlierTurn.metrics.errorCount + firstResidentTurn.metrics.errorCount,
      resultBytes: lastEarlierTurn.metrics.resultBytes + firstResidentTurn.metrics.resultBytes,
    };
  }
  grouping.turns = [...earlier.turns, ...grouping.turns];
  relabelRowsOfToolUseIds(grouping, newlyResolvedToolUseIds);
  return { newTurns: earlier.turns, mergedHead, mergedRows, needsRerender: newlyResolvedToolUseIds.size > 0 };
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
    if (row.record.kind === 'tool_call') {
      grouping.toolCallByUseId.delete(row.record.toolUseId);
      continue;
    }
    const toolUseId = referencedToolUseId(row.record);
    if (toolUseId) releaseUnresolvedToolUseId(grouping.unresolvedToolUseCounts, toolUseId);
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
  const droppedRows = oldestTurn.rows.slice(0, droppedRowCount);
  forgetRowToolCalls(grouping, droppedRows);
  for (const row of droppedRows) updateTraceTurnMetrics(oldestTurn, row, -1);
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

export function traceSessionStartedAtMs(
  firstOffset: number,
  hasDroppedEarliestRows: boolean,
  firstTurn: TraceTurn | null | undefined,
): number | null {
  if (firstOffset !== 0 || hasDroppedEarliestRows) return null;
  return firstTurn?.startedAt ?? null;
}

export function toggleHiddenKind(hidden: readonly string[], kind: string): string[] {
  if (isKindHidden(hidden, kind)) return hidden.filter((hiddenKind) => hiddenKind !== kind);
  return [...hidden, kind];
}

export function isKindHidden(hidden: readonly string[], kind: string): boolean {
  return hidden.includes(kind);
}

export function traceEmptyState(session: TraceSessionOption | null): string {
  if (!session) return 'No sessions are available.';
  return `No trace has been recorded for ${session.label}.`;
}
