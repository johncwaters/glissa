import fs from 'node:fs';
import path from 'node:path';

import type { Browser, BrowserContext, ConsoleMessage, Page } from 'playwright-core';

import { safeTextTail } from '../support/backend-harness.ts';
import { heightWithKeyboardUp, layoutFor } from './cases-core.ts';
import type { CardControl, HarnessCase, Layout, ResolvedStep, Step, ViewerId, Viewport } from './cases-core.ts';
import { expectedRows, parseStatusRow } from './frame-core.ts';
import { CARD_REGISTRY_URL, boardRowIds, dispatchWindowBlur, dropDataSocket, pillIds, readDocumentEngagement, readGrid, readLayout, readTerminalFocus, setDocumentEngagement } from './probe.ts';
import type { GridReading } from './probe.ts';
import { caseKey } from './report-core.ts';
import type { CaseRecord, GridSnapshot, Outcome, StepRecord } from './report-core.ts';

export interface Deadlines {
  pageReadyMs: number;
  settleMs: number;
  reattachMs: number;
  stepMs: number;
  pollIntervalMs: number;
}

export interface ArtifactPaths {
  shotsDir: string;
  diffsDir: string;
  logsDir: string;
}

export interface RunCaseOptions {
  browser: Browser;
  harnessCase: HarnessCase;
  sessionId: string;
  baseUrl: string;
  artifacts: ArtifactPaths;
  deadlines: Deadlines;
}

export const DEFAULT_DEADLINES: Deadlines = {
  pageReadyMs: 10000,
  settleMs: 15000,
  reattachMs: 40000,
  stepMs: 15000,
  pollIntervalMs: 50,
};

export const COLD_START_PAGE_READY_MS = 60000;

const CONSOLE_TAIL_LIMIT = 200;
const GRID_SETTLE_HOLD_MS = 600;
const WEB_SOCKET_OPEN = 1;
const PHONE_CARD_SLOT = '.phone-card-slot';
const DESKTOP_CARD_SLOT = '.focus-card-slot';
const DESKTOP_LEAVE_FOCUS_SELECTOR = '#tab-settings';
const DESKTOP_ENTER_FOCUS_SELECTOR = '#tab-focus';
const PHONE_BACK_SELECTOR = 'button.phone-back';
const SELECTOR_BY_CONTROL: Record<CardControl, string> = {
  'plan-terminal': 'button.plan-terminal-button:not(.plan-read-button)',
};

interface RememberedGrid {
  cols: number;
  rows: number;
}

interface RowMismatch {
  index: number;
  expected: string;
  actual: string;
}

interface ProbeResult {
  ok: boolean;
  detail: string;
  reading?: GridReading | null;
  mismatch?: RowMismatch | null;
  tick?: number | null;
}

interface PollResult {
  ok: boolean;
  detail: string;
  last: ProbeResult | null;
}

interface Viewer {
  id: ViewerId;
  viewport: Viewport;
  layout: Layout;
  context: BrowserContext;
  page: Page;
  width: number;
  height: number;
  restoreHeight: number;
}

interface CaseLog {
  lines: string[];
  consoleErrors: string[];
  pageErrors: string[];
}

interface StepOutcome {
  ok: boolean;
  predicate: string;
  detail: string;
  grid: GridSnapshot | null;
  shot: string | null;
  mismatch: RowMismatch | null;
  diffPath: string | null;
}

function pushBoundedLine(lines: string[], line: string): void {
  lines.push(line);
  if (lines.length > CONSOLE_TAIL_LIMIT) lines.shift();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

async function pollUntil(
  probe: () => Promise<ProbeResult>,
  { label, timeoutMs, intervalMs }: { label: string; timeoutMs: number; intervalMs: number },
): Promise<PollResult> {
  const deadline = Date.now() + timeoutMs;
  let last: ProbeResult | null = null;
  while (true) {
    last = await probe();
    if (last.ok) return { ok: true, detail: last.detail, last };
    if (Date.now() >= deadline) {
      return { ok: false, detail: `${label} timed out after ${timeoutMs}ms: ${last.detail}`, last };
    }
    await sleep(intervalMs);
  }
}

function firstMismatch(expected: readonly string[], actual: readonly string[]): RowMismatch | null {
  const rowCount = Math.max(expected.length, actual.length);
  for (let index = 0; index < rowCount; index += 1) {
    const expectedRow = expected[index] ?? '';
    const actualRow = actual[index] ?? '';
    if (expectedRow === actualRow) continue;
    return { index, expected: expectedRow, actual: actualRow };
  }
  return null;
}

function snapshotOf(reading: GridReading, tick: number | null): GridSnapshot {
  return {
    cols: reading.cols,
    rows: reading.rows,
    tick,
    dataGrid: reading.dataGrid,
    face: reading.face,
    bufferLength: reading.bufferLength,
  };
}

function describeStep(step: Step): string {
  if (step.kind === 'resize') return `resize ${step.width}x${step.height}`;
  if (step.kind === 'keyboard') return `keyboard ${step.state}`;
  if (step.kind === 'type') return `type ${step.text}`;
  if (step.kind === 'burst') return `burst ${step.lines}`;
  if (step.kind === 'settle') {
    const at = step.expectRemembered === undefined ? '' : ` at ${step.expectRemembered}`;
    return `settle ${step.expectGrid ?? 'exact'}${at}`;
  }
  if (step.kind === 'remember') return `remember ${step.label}`;
  if (step.kind === 'background') return step.quiet === true ? 'background quiet' : 'background';
  if (step.kind === 'foreground') return step.quiet === true ? 'foreground quiet' : 'foreground';
  if (step.kind === 'wait') return `wait ${step.durationMs}ms`;
  if (step.kind === 'assert-grid') return `assert-grid tick+${step.tickOffset ?? 0}`;
  if (step.kind === 'expect-face') return `expect-face ${step.value}`;
  if (step.kind === 'click') return `click ${step.control}`;
  if (step.kind === 'shot') return `shot ${step.name}`;
  return step.kind;
}

function sourceOf(step: Step): string {
  return `${step.viewer ?? 'a'} ${describeStep(step)}`;
}

function passedOutcome(predicate: string, detail: string): StepOutcome {
  return { ok: true, predicate, detail, grid: null, shot: null, mismatch: null, diffPath: null };
}

function failedOutcome(predicate: string, detail: string, mismatch: RowMismatch | null = null): StepOutcome {
  return { ok: false, predicate, detail, grid: null, shot: null, mismatch, diffPath: null };
}

function outcomeFor(predicate: string, poll: PollResult): StepOutcome {
  if (!poll.ok) return failedOutcome(predicate, poll.detail);
  return passedOutcome(predicate, poll.detail);
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function readGridOf(viewer: Viewer, sessionId: string): Promise<GridReading | null> {
  return viewer.page.evaluate(readGrid, { sessionId, registryUrl: CARD_REGISTRY_URL });
}

function cardSlotSelector(viewer: Viewer): string {
  if (viewer.layout === 'phone') return PHONE_CARD_SLOT;
  return DESKTOP_CARD_SLOT;
}

function rosterSelector(viewer: Viewer, sessionId: string): string {
  if (viewer.layout === 'phone') return `button.phone-row[data-id="${sessionId}"]`;
  return `button.focus-pill[data-id="${sessionId}"]`;
}

function listedIds(viewer: Viewer): Promise<string[]> {
  if (viewer.layout === 'phone') return viewer.page.evaluate(boardRowIds);
  return viewer.page.evaluate(pillIds);
}

async function probeCardLive(viewer: Viewer, sessionId: string): Promise<ProbeResult> {
  const reading = await readGridOf(viewer, sessionId);
  if (!reading) return { ok: false, detail: 'the session card carries no terminal yet', reading: null };
  if (reading.dataWsState !== WEB_SOCKET_OPEN) {
    return { ok: false, detail: `data socket state ${String(reading.dataWsState)}`, reading };
  }
  return { ok: true, detail: `live at ${reading.cols}x${reading.rows}`, reading };
}

async function probeSettled(
  viewer: Viewer,
  sessionId: string,
  expectGrid: 'exact' | 'following',
  remembered: RememberedGrid | null,
): Promise<ProbeResult> {
  const reading = await readGridOf(viewer, sessionId);
  if (!reading) return { ok: false, detail: 'the session card carries no terminal yet', reading: null };
  if (remembered && (reading.cols !== remembered.cols || reading.rows !== remembered.rows)) {
    return {
      ok: false,
      reading,
      detail: `grid is ${reading.cols}x${reading.rows}, wanted the remembered ${remembered.cols}x${remembered.rows}`,
    };
  }
  const authoritative = reading.ptySize;
  if (!authoritative) return { ok: false, detail: 'no authoritative pty size has arrived', reading };
  if (authoritative.cols !== reading.cols || authoritative.rows !== reading.rows) {
    return {
      ok: false,
      reading,
      detail: `pty is ${authoritative.cols}x${authoritative.rows} while the grid is ${reading.cols}x${reading.rows}`,
    };
  }
  if (reading.dataGrid !== expectGrid) {
    return { ok: false, reading, detail: `data-grid is ${String(reading.dataGrid)}, wanted ${expectGrid}` };
  }
  if (reading.bufferLength !== reading.rows) {
    return { ok: false, reading, detail: `buffer holds ${reading.bufferLength} lines for ${reading.rows} rows` };
  }
  const statusRow = reading.lines[reading.rows - 1] ?? '';
  const status = parseStatusRow(statusRow);
  if (!status) return { ok: false, reading, detail: `last row carries no status: ${JSON.stringify(statusRow)}` };
  if (status.cols !== reading.cols || status.rows !== reading.rows) {
    return {
      ok: false,
      reading,
      tick: status.tick,
      detail: `agent painted ${status.cols}x${status.rows} while the grid is ${reading.cols}x${reading.rows}`,
    };
  }
  const mismatch = firstMismatch(expectedRows(reading.cols, reading.rows, status.tick), reading.lines);
  if (mismatch) {
    return { ok: false, reading, tick: status.tick, mismatch, detail: `row ${mismatch.index} differs from the ruler frame` };
  }
  return { ok: true, reading, tick: status.tick, detail: `settled at ${reading.cols}x${reading.rows} tick ${status.tick}` };
}

function writeDiffFile(artifacts: ArtifactPaths, key: string, mismatch: RowMismatch, detail: string): string {
  const diffPath = path.join(artifacts.diffsDir, `${key}.txt`);
  const body = [
    detail,
    `first differing row: ${mismatch.index}`,
    `expected: ${JSON.stringify(mismatch.expected)}`,
    `actual:   ${JSON.stringify(mismatch.actual)}`,
    '',
  ].join('\n');
  fs.writeFileSync(diffPath, body, 'utf8');
  return diffPath;
}

async function waitForPageReady(viewer: Viewer, expectedLayout: Layout, deadlines: Deadlines): Promise<PollResult> {
  return pollUntil(async () => {
    const layout = await viewer.page.evaluate(readLayout);
    if (!layout.appReady) return { ok: false, detail: 'the dashboard has not stamped app-ready' };
    if (layout.layout !== expectedLayout) {
      return { ok: false, detail: `layout is ${String(layout.layout)}, wanted ${expectedLayout}` };
    }
    return { ok: true, detail: `ready in the ${expectedLayout} layout` };
  }, { label: `page ready for viewer ${viewer.id}`, timeoutMs: deadlines.pageReadyMs, intervalMs: deadlines.pollIntervalMs });
}

async function runOpen(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  const rosterEntry = viewer.page.locator(rosterSelector(viewer, sessionId)).first();
  const listed = await pollUntil(async () => {
    const isListed = await rosterEntry.count() > 0;
    if (isListed && await rosterEntry.isVisible()) return { ok: true, detail: 'the session is listed' };
    if (isListed && viewer.layout === 'desktop') {
      await viewer.page.locator(DESKTOP_ENTER_FOCUS_SELECTOR).first().click();
      return { ok: false, detail: 'the roster is listed behind another view' };
    }
    const ids = await listedIds(viewer);
    return { ok: false, detail: `${sessionId} is missing from ${ids.length} listed sessions` };
  }, { label: `session listed for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  if (!listed.ok) return failedOutcome('session-listed', listed.detail);
  await rosterEntry.click();
  const live = await pollUntil(
    () => probeCardLive(viewer, sessionId),
    { label: `card live for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs },
  );
  return outcomeFor('card-live', live);
}

async function runBack(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  const selector = viewer.layout === 'phone' ? PHONE_BACK_SELECTOR : DESKTOP_LEAVE_FOCUS_SELECTOR;
  await viewer.page.locator(selector).first().click();
  const released = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    if (!reading) return { ok: true, detail: 'the card no longer carries a terminal' };
    if (reading.dataGrid === 'exact') return { ok: false, reading, detail: 'the viewer still holds an exact grid claim' };
    return { ok: true, reading, detail: `released to ${String(reading.dataGrid)}` };
  }, { label: `viewer ${viewer.id} released the grid`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('grid-released', released);
}

async function runKeyboard(viewer: Viewer, state: 'up' | 'down', deadlines: Deadlines): Promise<StepOutcome> {
  const keyboardHeight = viewer.viewport.keyboardHeight;
  if (state === 'up' && keyboardHeight === undefined) {
    return failedOutcome('keyboard-open', `${viewer.viewport.name} declares no keyboard height`);
  }
  if (state === 'up' && keyboardHeight !== undefined) {
    const keyboardUpHeight = heightWithKeyboardUp(viewer.height, keyboardHeight);
    viewer.restoreHeight = viewer.height;
    await viewer.page.setViewportSize({ width: viewer.width, height: keyboardUpHeight });
    viewer.height = keyboardUpHeight;
  }
  if (state === 'down') {
    await viewer.page.setViewportSize({ width: viewer.width, height: viewer.restoreHeight });
    viewer.height = viewer.restoreHeight;
  }
  const wanted = state === 'up' ? 'open' : 'closed';
  const settled = await pollUntil(async () => {
    const layout = await viewer.page.evaluate(readLayout);
    const isOpen = layout.keyboard === 'open';
    if (state === 'up' && isOpen) return { ok: true, detail: 'the shell reports an open keyboard' };
    if (state === 'down' && !isOpen) return { ok: true, detail: 'the shell reports a closed keyboard' };
    return { ok: false, detail: `data-keyboard is ${String(layout.keyboard)}, wanted ${wanted}` };
  }, { label: `keyboard ${state} for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor(`keyboard-${state}`, settled);
}

async function runType(viewer: Viewer, text: string): Promise<StepOutcome> {
  await viewer.page.locator(cardSlotSelector(viewer)).first().click();
  await viewer.page.keyboard.type(text);
  await viewer.page.keyboard.press('Enter');
  return passedOutcome('typed', `sent ${JSON.stringify(text)}`);
}

async function runOffline(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  await viewer.context.setOffline(true);
  await viewer.page.evaluate(dropDataSocket, { sessionId, registryUrl: CARD_REGISTRY_URL });
  const dropped = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    if (!reading) return { ok: true, detail: 'the card no longer carries a terminal' };
    if (reading.dataWsState === WEB_SOCKET_OPEN) return { ok: false, reading, detail: 'the data socket is still open' };
    return { ok: true, reading, detail: `data socket state ${String(reading.dataWsState)}` };
  }, { label: `viewer ${viewer.id} went offline`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('socket-dropped', dropped);
}

async function runOnline(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  await viewer.context.setOffline(false);
  const reattached = await pollUntil(
    () => probeCardLive(viewer, sessionId),
    { label: `viewer ${viewer.id} reattached`, timeoutMs: deadlines.reattachMs, intervalMs: deadlines.pollIntervalMs },
  );
  return outcomeFor('socket-reattached', reattached);
}

async function runEngagement(viewer: Viewer, engaged: boolean, quiet: boolean): Promise<StepOutcome> {
  if (engaged && !quiet) await viewer.page.bringToFront();
  await viewer.page.evaluate(setDocumentEngagement, { engaged, quiet });
  const reading = await viewer.page.evaluate(readDocumentEngagement);
  const predicate = engaged ? 'viewer-foregrounded' : 'viewer-backgrounded';
  const detail = `hasFocus ${reading.hasFocus}, visibilityState ${reading.visibilityState}`;
  const isEngaged = reading.hasFocus && reading.visibilityState === 'visible';
  if (isEngaged !== engaged) return failedOutcome(predicate, detail);
  return passedOutcome(predicate, detail);
}

async function runWindowBlur(viewer: Viewer): Promise<StepOutcome> {
  await viewer.page.evaluate(setDocumentEngagement, { engaged: false, quiet: true });
  await viewer.page.evaluate(dispatchWindowBlur);
  const reading = await viewer.page.evaluate(readDocumentEngagement);
  const detail = `hasFocus ${reading.hasFocus}, visibilityState ${reading.visibilityState}`;
  if (reading.hasFocus || reading.visibilityState !== 'visible') return failedOutcome('window-blurred', detail);
  return passedOutcome('window-blurred', detail);
}

async function runTapTerminal(viewer: Viewer, deadlines: Deadlines): Promise<StepOutcome> {
  await viewer.page.locator(cardSlotSelector(viewer)).first().click();
  const focused = await pollUntil(async () => {
    const inTerminal = await viewer.page.evaluate(readTerminalFocus);
    if (!inTerminal) return { ok: false, detail: 'focus is outside the terminal wrapper' };
    return { ok: true, detail: 'the terminal holds focus' };
  }, { label: `terminal focus for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('terminal-focused', focused);
}

async function runRemember(
  viewer: Viewer,
  sessionId: string,
  label: string,
  rememberedByKey: Map<string, RememberedGrid>,
): Promise<StepOutcome> {
  const reading = await readGridOf(viewer, sessionId);
  if (!reading) return failedOutcome('grid-remembered', 'the session card carries no terminal to remember');
  rememberedByKey.set(`${viewer.id}:${label}`, { cols: reading.cols, rows: reading.rows });
  return passedOutcome('grid-remembered', `${label} is ${reading.cols}x${reading.rows}`);
}

async function readTick(viewer: Viewer, sessionId: string): Promise<number | null> {
  const reading = await readGridOf(viewer, sessionId);
  if (!reading) return null;
  const status = parseStatusRow(reading.lines[reading.rows - 1] ?? '');
  if (!status) return null;
  return status.tick;
}

async function runSettle(
  viewer: Viewer,
  sessionId: string,
  expectGrid: 'exact' | 'following',
  remembered: RememberedGrid | null,
  tickMustExceed: number | null,
  deadlines: Deadlines,
  artifacts: ArtifactPaths,
  key: string,
): Promise<StepOutcome> {
  let heldKey = '';
  let heldSince = 0;
  const settled = await pollUntil(async () => {
    const attempt = await probeSettled(viewer, sessionId, expectGrid, remembered);
    if (!attempt.ok) {
      heldKey = '';
      return attempt;
    }
    if (tickMustExceed !== null && (attempt.tick ?? -1) <= tickMustExceed) {
      heldKey = '';
      return { ...attempt, ok: false, detail: `${attempt.detail}, still at or below the pre burst tick ${tickMustExceed}` };
    }
    const reached = attempt.reading;
    const fixpointKey = `${reached?.cols}x${reached?.rows}#${attempt.tick}`;
    if (fixpointKey !== heldKey) {
      heldKey = fixpointKey;
      heldSince = Date.now();
    }
    const heldMs = Date.now() - heldSince;
    if (heldMs >= GRID_SETTLE_HOLD_MS) return attempt;
    return { ...attempt, ok: false, detail: `${attempt.detail} but held only ${heldMs}ms` };
  }, { label: `grid fixpoint for viewer ${viewer.id}`, timeoutMs: deadlines.settleMs, intervalMs: deadlines.pollIntervalMs });
  const reading = settled.last?.reading ?? null;
  const tick = settled.last?.tick ?? null;
  const grid = reading ? snapshotOf(reading, tick) : null;
  if (settled.ok) return { ...passedOutcome('grid-fixpoint', settled.detail), grid };
  const mismatch = settled.last?.mismatch ?? null;
  const diffPath = mismatch ? writeDiffFile(artifacts, key, mismatch, settled.detail) : null;
  return { ok: false, predicate: 'grid-fixpoint', detail: settled.detail, grid, shot: null, mismatch, diffPath };
}

async function runAssertGrid(
  viewer: Viewer,
  sessionId: string,
  tickOffset: number,
  artifacts: ArtifactPaths,
  key: string,
): Promise<StepOutcome> {
  const reading = await readGridOf(viewer, sessionId);
  if (!reading) return failedOutcome('grid-assertion', 'the session card carries no terminal');
  const statusRow = reading.lines[reading.rows - 1] ?? '';
  const status = parseStatusRow(statusRow);
  if (!status) {
    return failedOutcome('grid-assertion', `last row carries no status: ${JSON.stringify(statusRow)}`);
  }
  const wantedTick = status.tick + tickOffset;
  const mismatch = firstMismatch(expectedRows(reading.cols, reading.rows, wantedTick), reading.lines);
  const grid = snapshotOf(reading, status.tick);
  if (!mismatch) {
    return { ...passedOutcome('grid-assertion', `every row matches tick ${wantedTick}`), grid };
  }
  const detail = `row ${mismatch.index} differs from the frame expected at tick ${wantedTick}`;
  const diffPath = writeDiffFile(artifacts, key, mismatch, detail);
  return { ok: false, predicate: 'grid-assertion', detail, grid, shot: null, mismatch, diffPath };
}

async function runExpectFace(
  viewer: Viewer,
  sessionId: string,
  value: 'plan' | 'terminal',
  deadlines: Deadlines,
): Promise<StepOutcome> {
  const faced = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    if (!reading) return { ok: false, detail: 'the session card carries no terminal yet' };
    if (reading.face !== value) return { ok: false, reading, detail: `face is ${String(reading.face)}, wanted ${value}` };
    return { ok: true, reading, detail: `face is ${value}` };
  }, { label: `face ${value} for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('card-face', faced);
}

async function runClick(
  viewer: Viewer,
  control: CardControl,
  deadlines: Deadlines,
): Promise<StepOutcome> {
  const button = viewer.page.locator(`${cardSlotSelector(viewer)} ${SELECTOR_BY_CONTROL[control]}`).first();
  const shown = await pollUntil(async () => {
    if (await button.count() === 0) return { ok: false, detail: `${control} is not on the card` };
    if (!await button.isVisible()) return { ok: false, detail: `${control} is on the card but hidden` };
    return { ok: true, detail: `${control} is clickable` };
  }, { label: `${control} for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  if (!shown.ok) return failedOutcome('control-clickable', shown.detail);
  await button.click();
  return passedOutcome('control-clicked', `clicked ${control}`);
}

async function takeShot(viewer: Viewer, artifacts: ArtifactPaths, key: string, name: string): Promise<StepOutcome> {
  const shotPath = path.join(artifacts.shotsDir, `${key}--${name}.png`);
  await viewer.page.screenshot({ path: shotPath, fullPage: false });
  return { ...passedOutcome('screenshot', shotPath), shot: shotPath };
}

async function createViewer(
  browser: Browser,
  viewerId: ViewerId,
  viewport: Viewport,
  layout: Layout,
  baseUrl: string,
  log: CaseLog,
): Promise<Viewer> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.hasTouch,
    isMobile: viewport.isMobile,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('console', (message: ConsoleMessage) => {
    const line = `[${viewerId}] ${message.type()}: ${safeTextTail(message.text(), 500)}`;
    pushBoundedLine(log.lines, line);
    if (message.type() === 'error') pushBoundedLine(log.consoleErrors, line);
  });
  page.on('pageerror', (error: Error) => {
    const line = `[${viewerId}] ${safeTextTail(error.stack ?? error.message, 800)}`;
    pushBoundedLine(log.lines, line);
    pushBoundedLine(log.pageErrors, line);
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  return {
    id: viewerId,
    viewport,
    layout,
    context,
    page,
    width: viewport.width,
    height: viewport.height,
    restoreHeight: viewport.height,
  };
}

async function closeViewer(viewer: Viewer | null): Promise<void> {
  if (!viewer) return;
  try {
    await viewer.context.close();
  } catch {}
}

export async function runCase({
  browser,
  harnessCase,
  sessionId,
  baseUrl,
  artifacts,
  deadlines,
}: RunCaseOptions): Promise<CaseRecord> {
  const key = caseKey({ viewport: harnessCase.viewport.name, scenario: harnessCase.scenario.name });
  const log: CaseLog = { lines: [], consoleErrors: [], pageErrors: [] };
  const startedAt = Date.now();
  const steps: StepRecord[] = [];
  const shots: string[] = [];
  const logPath = path.join(artifacts.logsDir, `${key}.log`);
  let observedLayout: string | null = null;
  let outcome: Outcome = 'passed';
  let viewerA: Viewer | null = null;
  let viewerB: Viewer | null = null;

  const companionLayout = harnessCase.companion ? layoutFor(harnessCase.companion) : null;

  const viewerFor = async (viewerId: ViewerId): Promise<Viewer> => {
    if (viewerId === 'a') {
      if (viewerA) return viewerA;
      viewerA = await createViewer(browser, 'a', harnessCase.viewport, harnessCase.expectedLayout, baseUrl, log);
      const ready = await waitForPageReady(viewerA, harnessCase.expectedLayout, deadlines);
      const layout = await viewerA.page.evaluate(readLayout);
      observedLayout = layout.layout;
      if (!ready.ok) throw new Error(ready.detail);
      return viewerA;
    }
    if (viewerB) return viewerB;
    const companion = harnessCase.companion;
    if (!companion) throw new Error(`${key} asks for a companion viewer but declares no companion viewport`);
    const layout = companionLayout ?? 'desktop';
    viewerB = await createViewer(browser, 'b', companion, layout, baseUrl, log);
    const ready = await waitForPageReady(viewerB, layout, {
      ...deadlines,
      pageReadyMs: Math.min(deadlines.pageReadyMs, DEFAULT_DEADLINES.pageReadyMs),
    });
    if (!ready.ok) throw new Error(ready.detail);
    return viewerB;
  };

  const tickToPassAtNextSettleByViewer = new Map<ViewerId, number>();
  const rememberedGridByKey = new Map<string, RememberedGrid>();

  const runStep = async (step: ResolvedStep): Promise<StepOutcome> => {
    const viewer = await viewerFor(step.viewer ?? 'a');
    if (step.kind === 'open') return runOpen(viewer, sessionId, deadlines);
    if (step.kind === 'back') return runBack(viewer, sessionId, deadlines);
    if (step.kind === 'resize') {
      await viewer.page.setViewportSize({ width: step.width, height: step.height });
      viewer.width = step.width;
      viewer.height = step.height;
      viewer.restoreHeight = step.height;
      return passedOutcome('resized', `${step.width}x${step.height}`);
    }
    if (step.kind === 'keyboard') return runKeyboard(viewer, step.state, deadlines);
    if (step.kind === 'type') return runType(viewer, step.text);
    if (step.kind === 'burst') {
      const tickBeforeBurst = await readTick(viewer, sessionId);
      if (tickBeforeBurst === null) {
        return failedOutcome('burst-baseline', 'no status row carried a tick to measure the burst against');
      }
      tickToPassAtNextSettleByViewer.set(viewer.id, tickBeforeBurst);
      return runType(viewer, `burst ${step.lines}`);
    }
    if (step.kind === 'offline') return runOffline(viewer, sessionId, deadlines);
    if (step.kind === 'online') return runOnline(viewer, sessionId, deadlines);
    if (step.kind === 'foreground') return runEngagement(viewer, true, step.quiet === true);
    if (step.kind === 'wait') {
      await sleep(step.durationMs);
      return passedOutcome('waited', `${step.durationMs}ms passed`);
    }
    if (step.kind === 'background') return runEngagement(viewer, false, step.quiet === true);
    if (step.kind === 'window-blur') return runWindowBlur(viewer);
    if (step.kind === 'tap-terminal') return runTapTerminal(viewer, deadlines);
    if (step.kind === 'remember') return runRemember(viewer, sessionId, step.label, rememberedGridByKey);
    if (step.kind === 'settle') {
      const tickMustExceed = tickToPassAtNextSettleByViewer.get(viewer.id) ?? null;
      tickToPassAtNextSettleByViewer.delete(viewer.id);
      const remembered = step.expectRemembered === undefined
        ? null
        : rememberedGridByKey.get(`${viewer.id}:${step.expectRemembered}`) ?? null;
      return runSettle(viewer, sessionId, step.expectGrid ?? 'exact', remembered, tickMustExceed, deadlines, artifacts, key);
    }
    if (step.kind === 'assert-grid') {
      return runAssertGrid(viewer, sessionId, step.tickOffset ?? 0, artifacts, key);
    }
    if (step.kind === 'expect-face') return runExpectFace(viewer, sessionId, step.value, deadlines);
    if (step.kind === 'click') return runClick(viewer, step.control, deadlines);
    const shot = await takeShot(viewer, artifacts, key, step.name);
    if (shot.shot) shots.push(shot.shot);
    return shot;
  };

  try {
    for (const [index, step] of harnessCase.scenario.steps.entries()) {
      const stepStartedAt = Date.now();
      let result: StepOutcome;
      try {
        result = await runStep(step);
      } catch (error) {
        result = failedOutcome('driver', safeTextTail(errorText(error), 800));
      }
      const crashed = log.pageErrors.length > 0;
      const stepFailed = !result.ok || crashed;
      steps.push({
        index,
        source: sourceOf(step),
        outcome: stepFailed ? 'failed' : 'passed',
        durationMs: Date.now() - stepStartedAt,
        grid: result.grid,
        shot: result.shot,
        failure: stepFailed
          ? {
            predicate: crashed && result.ok ? 'no-page-error' : result.predicate,
            detail: crashed && result.ok ? (log.pageErrors[0] ?? 'a page error was raised') : result.detail,
            firstDifferingRow: result.mismatch?.index ?? null,
            expectedRow: result.mismatch?.expected ?? null,
            actualRow: result.mismatch?.actual ?? null,
            diffPath: result.diffPath,
          }
          : null,
      });
      if (!stepFailed) continue;
      outcome = 'failed';
      break;
    }
  } catch (error) {
    outcome = 'failed';
    steps.push({
      index: steps.length,
      source: 'case',
      outcome: 'failed',
      durationMs: 0,
      grid: null,
      shot: null,
      failure: {
        predicate: 'driver',
        detail: safeTextTail(errorText(error), 800),
        firstDifferingRow: null,
        expectedRow: null,
        actualRow: null,
        diffPath: null,
      },
    });
  }

  if (outcome === 'failed' && viewerA) {
    try {
      const failureShot = await takeShot(viewerA, artifacts, key, 'failure');
      if (failureShot.shot) shots.push(failureShot.shot);
    } catch {}
  }

  await closeViewer(viewerB);
  await closeViewer(viewerA);

  fs.writeFileSync(logPath, `${log.lines.join('\n')}\n`, 'utf8');

  if (outcome === 'failed' && harnessCase.scenario.optional === true) outcome = 'skipped';

  return {
    viewport: harnessCase.viewport.name,
    width: harnessCase.viewport.width,
    height: harnessCase.viewport.height,
    expectedLayout: harnessCase.expectedLayout,
    observedLayout,
    scenario: harnessCase.scenario.name,
    optional: harnessCase.scenario.optional === true,
    outcome,
    durationMs: Date.now() - startedAt,
    steps,
    shots,
    logPath,
    consoleErrors: log.consoleErrors,
    pageErrors: log.pageErrors,
  };
}
