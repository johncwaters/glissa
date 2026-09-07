import type { TraceRecord } from '#shared/contracts/trace.ts';
import { buildPanelSection, el, isPanelHidden, writeClipboardText } from './dom-helpers.ts';
import {
  appendTraceRecords,
  createTraceGrouping,
  earlierTraceRequest,
  hasEarlierTracePages,
  nextTraceRequest,
  prependTraceRecords,
  resolveTraceSessionId,
  shouldRebuildTraceView,
  traceEmptyState,
  traceRecordBody,
  traceReplyOutcome,
  traceResidentRowCount,
  traceSessionOptions,
  trimTraceGrouping,
} from './trace-view-core.ts';
import type {
  TraceGrouping,
  TracePrepend,
  TraceRequest,
  TraceSessionOption,
  TraceSessionSummary,
  TraceTurn,
  TraceTurnAppend,
  TraceViewRow,
} from './trace-view-core.ts';

const TRACE_REQUEST_TIMEOUT_MS = 10000;

interface SelectedTrace {
  sessionId: string;
  grouping: TraceGrouping;
  firstOffset: number;
  nextOffset: number;
  hasDroppedEarliestRows: boolean;
  filePath: string;
  hasLoadedOnce: boolean;
}

interface PendingTraceRequest {
  request: TraceRequest;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface TraceReply {
  id: string;
  records: TraceRecord[];
  start: number;
  next: number;
  reset: boolean;
  path: string;
}

interface TurnSection {
  section: HTMLElement;
  rowsElement: HTMLElement;
}

let rootElement: HTMLDivElement | null = null;
let headerElement: HTMLElement | null = null;
let turnsElement: HTMLElement | null = null;
let loadEarlierControlElement: HTMLElement | null = null;
let turnRowsElements: HTMLElement[] = [];
let isRenderedTraceStale = false;

let sendRequest: ((message: Record<string, unknown>) => boolean) | null = null;
let navigateToTrace: (() => void) | null = null;
let sessionOptions: TraceSessionOption[] = [];
let selectedSessionId: string | null = null;
let preselectedSessionId: string | null = null;
let selectedTrace: SelectedTrace | null = null;
let pendingRequest: PendingTraceRequest | null = null;
let isRefreshNeeded = false;

function isTraceVisible(): boolean {
  return !!rootElement && !isPanelHidden(rootElement);
}

function selectedSession(): TraceSessionOption | null {
  return sessionOptions.find((option) => option.id === selectedSessionId) ?? null;
}

function clearPendingRequest(): void {
  if (!pendingRequest) return;
  clearTimeout(pendingRequest.timeoutHandle);
  pendingRequest = null;
}

function abandonPendingRequest(): void {
  pendingRequest = null;
  renderPanel();
}

function startSelectedTrace(sessionId: string | null): void {
  clearPendingRequest();
  isRefreshNeeded = false;
  selectedSessionId = sessionId;
  selectedTrace = sessionId
    ? {
      sessionId,
      grouping: createTraceGrouping(),
      firstOffset: 0,
      nextOffset: 0,
      hasDroppedEarliestRows: false,
      filePath: '',
      hasLoadedOnce: false,
    }
    : null;
  isRenderedTraceStale = true;
}

function applySelection(canFallBackToFirst: boolean): boolean {
  const nextSelectedId = resolveTraceSessionId(sessionOptions, preselectedSessionId, selectedSessionId, canFallBackToFirst);
  if (preselectedSessionId && nextSelectedId === preselectedSessionId) preselectedSessionId = null;
  if (nextSelectedId === selectedSessionId) return false;
  startSelectedTrace(nextSelectedId);
  return true;
}

function sendTraceRequest(request: TraceRequest): void {
  if (!sendRequest) return;
  const wireMessage = request.endingAt === undefined
    ? { type: 'session-trace', id: request.id, after: request.after }
    : { type: 'session-trace', id: request.id, endingAt: request.endingAt };
  if (!sendRequest(wireMessage)) return;
  pendingRequest = { request, timeoutHandle: setTimeout(abandonPendingRequest, TRACE_REQUEST_TIMEOUT_MS) };
}

function requestSelectedTrace(isSurfaceShown = false): void {
  if (!sendRequest) return;
  const request = nextTraceRequest({
    selectedSessionId,
    isPanelVisible: isSurfaceShown || isTraceVisible(),
    hasPendingRequest: !!pendingRequest,
    hasLoadedOnce: selectedTrace?.hasLoadedOnce ?? false,
    nextOffset: selectedTrace?.nextOffset ?? 0,
  });
  if (!request) return;
  sendTraceRequest(request);
}

function earlierPageInputs() {
  return {
    selectedSessionId,
    hasPendingRequest: !!pendingRequest,
    hasLoadedOnce: selectedTrace?.hasLoadedOnce ?? false,
    hasDroppedEarliestRows: selectedTrace?.hasDroppedEarliestRows ?? false,
    firstOffset: selectedTrace?.firstOffset ?? 0,
    residentRowCount: selectedTrace ? traceResidentRowCount(selectedTrace.grouping) : 0,
  };
}

function requestEarlierTrace(): void {
  if (!sendRequest) return;
  const request = earlierTraceRequest(earlierPageInputs());
  if (!request) return;
  sendTraceRequest(request);
}

function selectSession(sessionId: string): void {
  if (!sessionOptions.some((option) => option.id === sessionId)) return;
  if (sessionId === selectedSessionId) return;
  preselectedSessionId = null;
  startSelectedTrace(sessionId);
  requestSelectedTrace();
  renderPanel();
}

function buildSessionSelector(): HTMLLabelElement {
  const field = el('label', 'trace-session-field');
  const label = el('span', 'trace-session-label', 'Session');
  const select = el('select', 'trace-session-select');
  select.disabled = sessionOptions.length === 0;
  for (const optionValue of sessionOptions) {
    const option = el('option', null, optionValue.label);
    option.value = optionValue.id;
    option.selected = optionValue.id === selectedSessionId;
    select.append(option);
  }
  select.addEventListener('change', () => selectSession(select.value));
  field.append(label, select);
  return field;
}

function buildHeader(): HTMLElement {
  const section = buildPanelSection('trace', 'Session trace', 'Bodies load from the local trace file only when requested.');
  const controls = el('div', 'trace-controls');
  controls.append(buildSessionSelector());
  const pathValue = selectedTrace?.filePath ?? '';
  const path = el('code', 'trace-path', pathValue);
  path.title = pathValue;
  controls.append(path);
  section.append(controls);
  return section;
}

function buildCopyControl(body: string): HTMLElement {
  const wrap = el('div', 'trace-copy-wrap');
  const button = el('button', 'trace-copy', 'Copy');
  button.type = 'button';
  const status = el('span', 'trace-copy-status');
  status.setAttribute('role', 'status');
  button.addEventListener('click', () => {
    const write = writeClipboardText(body);
    if (!write) {
      status.textContent = 'Copy failed';
      return;
    }
    write
      .then(() => { status.textContent = 'Copied'; })
      .catch(() => { status.textContent = 'Copy failed'; });
    setTimeout(() => { status.textContent = ''; }, 1600);
  });
  wrap.append(button, status);
  return wrap;
}

function buildLoadEarlierControl(): HTMLElement {
  const wrap = el('div', 'trace-earlier-wrap');
  const button = el('button', 'trace-load-earlier', 'Load earlier');
  button.type = 'button';
  button.addEventListener('click', () => { requestEarlierTrace(); });
  wrap.append(button);
  return wrap;
}

function buildExpandableRow(row: TraceViewRow, className = ''): HTMLDetailsElement {
  const details = el('details', `trace-row${className ? ` ${className}` : ''}`);
  if (row.isMuted) details.dataset.tone = 'muted';
  const summary = el('summary', 'trace-row-summary', row.label);
  const body = el('div', 'trace-row-body');
  details.append(summary, body);
  let hasBody = false;
  details.addEventListener('toggle', () => {
    if (!details.open || hasBody) return;
    hasBody = true;
    const text = traceRecordBody(row.record);
    body.append(buildCopyControl(text), el('pre', 'trace-row-pre', text));
  });
  return details;
}

function buildTurnSection(turn: TraceTurn): TurnSection {
  const section = el('section', 'trace-turn');
  if (turn.head) section.append(buildExpandableRow(turn.head, 'trace-turn-head'));
  if (!turn.head) section.append(el('h2', 'trace-leading-title', 'Before first prompt'));
  const rowsElement = el('div', 'trace-rows');
  for (const row of turn.rows) rowsElement.append(buildExpandableRow(row));
  if (turn.hasTrimmedRows) section.append(el('p', 'trace-trimmed', 'Earlier rows trimmed'));
  section.append(rowsElement);
  return { section, rowsElement };
}

function emptyStateText(session: TraceSessionOption | null): string {
  if (!session) return traceEmptyState(null);
  const isFirstPageLoading = pendingRequest?.request.id === session.id && !selectedTrace?.hasLoadedOnce;
  return isFirstPageLoading ? 'Loading trace.' : traceEmptyState(session);
}

function buildPanelContent(): void {
  if (!rootElement) return;
  const content = el('div', 'trace-content');
  headerElement = buildHeader();
  content.append(headerElement);
  turnsElement = null;
  loadEarlierControlElement = null;
  turnRowsElements = [];
  const session = selectedSession();
  const turns = selectedTrace?.grouping.turns ?? [];
  if (!session || turns.length === 0) {
    content.append(el('p', 'trace-empty', emptyStateText(session)));
    rootElement.replaceChildren(content);
    isRenderedTraceStale = false;
    return;
  }
  if (hasEarlierTracePages(earlierPageInputs())) {
    loadEarlierControlElement = buildLoadEarlierControl();
    content.append(loadEarlierControlElement);
  }
  const list = el('div', 'trace-turns');
  for (const turn of turns) {
    const built = buildTurnSection(turn);
    turnRowsElements.push(built.rowsElement);
    list.append(built.section);
  }
  turnsElement = list;
  content.append(list);
  rootElement.replaceChildren(content);
  isRenderedTraceStale = false;
}

function renderPanel(): void {
  if (!rootElement) return;
  if (!isTraceVisible()) {
    isRenderedTraceStale = true;
    return;
  }
  buildPanelContent();
}

function renderHeader(): void {
  if (!headerElement || !isTraceVisible()) return;
  const nextHeader = buildHeader();
  headerElement.replaceWith(nextHeader);
  headerElement = nextHeader;
}

function applyTurnAppend(append: TraceTurnAppend): void {
  if (!turnsElement) return;
  if (append.isNewTurn) {
    const built = buildTurnSection({ head: append.head, rows: append.rows, hasTrimmedRows: false });
    turnRowsElements.push(built.rowsElement);
    turnsElement.append(built.section);
    return;
  }
  const rowsElement = turnRowsElements[append.turnIndex];
  if (!rowsElement) return;
  for (const row of append.rows) rowsElement.append(buildExpandableRow(row));
}

function markTurnRowsTrimmed(rowsElement: HTMLElement): void {
  const section = rowsElement.parentElement;
  if (!section || section.querySelector('.trace-trimmed')) return;
  section.insertBefore(el('p', 'trace-trimmed', 'Earlier rows trimmed'), rowsElement);
}

function syncLoadEarlierControl(): void {
  const shouldShowControl = hasEarlierTracePages(earlierPageInputs());
  if (!shouldShowControl) {
    loadEarlierControlElement?.remove();
    loadEarlierControlElement = null;
    return;
  }
  if (loadEarlierControlElement || !turnsElement?.parentElement) return;
  loadEarlierControlElement = buildLoadEarlierControl();
  turnsElement.parentElement.insertBefore(loadEarlierControlElement, turnsElement);
}

function dropOldestRows(): void {
  if (!selectedTrace) return;
  const trim = trimTraceGrouping(selectedTrace.grouping);
  const hasDroppedRows = trim.droppedTurnCount > 0 || trim.droppedRowCount > 0;
  if (!hasDroppedRows) {
    syncLoadEarlierControl();
    return;
  }
  selectedTrace.hasDroppedEarliestRows = true;
  turnRowsElements = turnRowsElements.slice(trim.droppedTurnCount);
  if (turnsElement) {
    for (let removedCount = 0; removedCount < trim.droppedTurnCount; removedCount += 1) turnsElement.firstElementChild?.remove();
  }
  const oldestRowsElement = turnRowsElements[0];
  if (oldestRowsElement && trim.droppedRowCount > 0) {
    for (let removedCount = 0; removedCount < trim.droppedRowCount; removedCount += 1) oldestRowsElement.firstElementChild?.remove();
    markTurnRowsTrimmed(oldestRowsElement);
  }
  syncLoadEarlierControl();
}

function showAppendedRecords(records: readonly TraceRecord[]): void {
  if (!selectedTrace) return;
  const appends = appendTraceRecords(selectedTrace.grouping, records);
  const canAppendInPlace = isTraceVisible() && !isRenderedTraceStale && !!turnsElement;
  if (canAppendInPlace) {
    for (const append of appends) applyTurnAppend(append);
    dropOldestRows();
    return;
  }
  turnsElement = null;
  dropOldestRows();
  if (!isTraceVisible()) {
    isRenderedTraceStale = true;
    return;
  }
  buildPanelContent();
}

function traceReplyFrom(message: unknown): TraceReply | null {
  if (!message || typeof message !== 'object') return null;
  const reply = message as { id?: unknown; records?: unknown; start?: unknown; next?: unknown; reset?: unknown; path?: unknown };
  if (typeof reply.id !== 'string' || !Array.isArray(reply.records)) return null;
  if (typeof reply.next !== 'number' || typeof reply.start !== 'number') return null;
  return {
    id: reply.id,
    records: reply.records as TraceRecord[],
    start: reply.start,
    next: reply.next,
    reset: reply.reset === true,
    path: typeof reply.path === 'string' ? reply.path : '',
  };
}

function requestQueuedRefresh(): void {
  if (!isRefreshNeeded || pendingRequest) return;
  isRefreshNeeded = false;
  requestSelectedTrace();
}

function applyPrependToRenderedTurns(prepend: TracePrepend): void {
  if (!turnsElement) return;
  const firstResidentRowsElement = turnRowsElements[0];
  if (prepend.mergedHead && firstResidentRowsElement?.parentElement) {
    firstResidentRowsElement.parentElement.querySelector('.trace-leading-title')?.remove();
    firstResidentRowsElement.parentElement.insertBefore(
      buildExpandableRow(prepend.mergedHead, 'trace-turn-head'),
      firstResidentRowsElement,
    );
    const mergedRowsFragment = document.createDocumentFragment();
    for (const row of prepend.mergedRows) mergedRowsFragment.append(buildExpandableRow(row));
    firstResidentRowsElement.prepend(mergedRowsFragment);
  }
  const newTurnsFragment = document.createDocumentFragment();
  const newRowsElements: HTMLElement[] = [];
  for (const turn of prepend.newTurns) {
    const built = buildTurnSection(turn);
    newRowsElements.push(built.rowsElement);
    newTurnsFragment.append(built.section);
  }
  turnsElement.prepend(newTurnsFragment);
  turnRowsElements.unshift(...newRowsElements);
}

function showPrependedRecords(records: readonly TraceRecord[]): void {
  if (!selectedTrace) return;
  const prepend = prependTraceRecords(selectedTrace.grouping, records);
  const canPrependInPlace = isTraceVisible() && !isRenderedTraceStale && !!turnsElement;
  if (!canPrependInPlace) {
    dropOldestRows();
    renderPanel();
    return;
  }
  const scrollElement = rootElement?.parentElement ?? null;
  const previousScrollHeight = scrollElement?.scrollHeight ?? 0;
  const previousScrollTop = scrollElement?.scrollTop ?? 0;
  applyPrependToRenderedTurns(prepend);
  dropOldestRows();
  if (scrollElement) scrollElement.scrollTop = previousScrollTop + scrollElement.scrollHeight - previousScrollHeight;
}

export function mountTraceView(parent: HTMLElement): void {
  if (rootElement) return;
  rootElement = el('div', 'trace-panel');
  parent.append(rootElement);
  buildPanelContent();
}

export function setTraceRequestSender(sender: (message: Record<string, unknown>) => boolean): void {
  sendRequest = sender;
}

export function setTraceNavigate(callback: () => void): void {
  navigateToTrace = callback;
}

export function openTraceForSession(sessionId: string): void {
  preselectedSessionId = sessionId;
  navigateToTrace?.();
}

export function setTraceSessions(sessions: readonly TraceSessionSummary[]): void {
  sessionOptions = traceSessionOptions(sessions);
  const hasSelectionChanged = applySelection(isTraceVisible());
  if (hasSelectionChanged) requestSelectedTrace();
  if (hasSelectionChanged || !headerElement) renderPanel();
  if (!hasSelectionChanged && headerElement) renderHeader();
}

export function refreshTraceView(): void {
  if (!rootElement) return;
  const hasSelectionChanged = applySelection(true);
  requestSelectedTrace(true);
  if (!shouldRebuildTraceView({ hasSelectionChanged, isRenderedTraceStale, hasRenderedOnce: !!headerElement })) return;
  buildPanelContent();
}

export function applyTraceResponse(message: unknown): void {
  const reply = traceReplyFrom(message);
  if (!reply) return;
  const outcome = traceReplyOutcome({
    pendingRequest: pendingRequest?.request ?? null,
    resident: selectedTrace
      ? {
        sessionId: selectedTrace.sessionId,
        firstOffset: selectedTrace.firstOffset,
        nextOffset: selectedTrace.nextOffset,
        hasLoadedOnce: selectedTrace.hasLoadedOnce,
      }
      : null,
    reply: { id: reply.id, start: reply.start, next: reply.next, reset: reply.reset },
  });
  if (outcome === 'ignore') {
    requestQueuedRefresh();
    return;
  }
  clearPendingRequest();
  if (outcome === 'stale') {
    requestQueuedRefresh();
    return;
  }
  if (outcome === 'reset') {
    startSelectedTrace(reply.id);
    if (selectedTrace) selectedTrace.filePath = reply.path;
    requestSelectedTrace();
    renderPanel();
    requestQueuedRefresh();
    return;
  }
  if (!selectedTrace) return;
  selectedTrace.filePath = reply.path;
  if (outcome === 'prepend') {
    selectedTrace.firstOffset = reply.start;
    showPrependedRecords(reply.records);
    requestQueuedRefresh();
    return;
  }
  if (outcome === 'seed') {
    selectedTrace.hasLoadedOnce = true;
    selectedTrace.firstOffset = reply.start;
  }
  selectedTrace.nextOffset = reply.next;
  showAppendedRecords(reply.records);
  requestQueuedRefresh();
}

export function applyTraceChanged(message: unknown): void {
  const sessionId = (message as { id?: unknown } | null)?.id;
  if (typeof sessionId !== 'string' || sessionId !== selectedSessionId) return;
  if (!isTraceVisible()) return;
  if (pendingRequest) {
    isRefreshNeeded = true;
    return;
  }
  requestSelectedTrace();
}

export function applyTraceError(message: unknown): void {
  const sessionId = (message as { id?: unknown } | null)?.id;
  if (typeof sessionId !== 'string' || pendingRequest?.request.id !== sessionId) return;
  clearPendingRequest();
  isRefreshNeeded = false;
  renderPanel();
}

export function applyTraceConnectionState(isConnected: boolean): void {
  clearPendingRequest();
  isRefreshNeeded = false;
  if (!isConnected) {
    renderPanel();
    return;
  }
  requestSelectedTrace();
}
