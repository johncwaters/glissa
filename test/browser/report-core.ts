export type Outcome = 'passed' | 'failed' | 'skipped';

export interface GridSnapshot {
  cols: number;
  rows: number;
  tick: number | null;
  dataGrid: string | null;
  face: string | null;
  bufferLength: number;
}

export interface StepFailure {
  predicate: string;
  detail: string;
  firstDifferingRow: number | null;
  expectedRow: string | null;
  actualRow: string | null;
  diffPath: string | null;
}

export interface StepRecord {
  index: number;
  source: string;
  outcome: Outcome;
  durationMs: number;
  grid: GridSnapshot | null;
  failure: StepFailure | null;
  shot: string | null;
}

export interface CaseRecord {
  viewport: string;
  width: number;
  height: number;
  expectedLayout: 'phone' | 'desktop';
  observedLayout: string | null;
  scenario: string;
  optional: boolean;
  outcome: Outcome;
  durationMs: number;
  steps: StepRecord[];
  shots: string[];
  logPath: string;
  consoleErrors: string[];
  pageErrors: string[];
}

export interface RunTotals {
  passed: number;
  failed: number;
  skipped: number;
}

export interface BrowserRunReport {
  version: 1;
  runId: string;
  startedAt: number;
  finishedAt: number;
  repoHead: string;
  node: string;
  playwrightCore: string;
  totals: RunTotals;
  cases: CaseRecord[];
}

export const PROVE_FAILURE_SCENARIO = 'self-check-must-fail';

export const EXIT_HARNESS_ERROR = 2;

export type HarnessExitCode = 0 | 1 | 2;

export interface SurvivorCheck {
  available: boolean;
  leftoverPids: readonly number[];
}

export interface ExitDecision {
  report: BrowserRunReport;
  proveFailure: boolean;
  selfCheck: { ok: boolean };
  survivors: SurvivorCheck;
}

const CONSOLE_ERROR_TAIL = 5;
const FENCE = '```';

const MATRIX_CELL_BY_OUTCOME: Record<Outcome, string> = {
  passed: 'ok',
  failed: 'FAIL',
  skipped: 'skip',
};

export function summarize(cases: CaseRecord[]): RunTotals {
  const totals: RunTotals = { passed: 0, failed: 0, skipped: 0 };
  for (const record of cases) totals[record.outcome] += 1;
  return totals;
}

export function exitCodeFor(report: BrowserRunReport): 0 | 1 {
  const hasBlockingFailure = report.cases.some(
    (record) => record.outcome === 'failed' && !record.optional,
  );
  if (hasBlockingFailure) return 1;
  return 0;
}

export function exitCodeExcludingSelfCheck(report: BrowserRunReport): 0 | 1 {
  const casesOutsideSelfCheck = report.cases.filter((record) => record.scenario !== PROVE_FAILURE_SCENARIO);
  return exitCodeFor({ ...report, cases: casesOutsideSelfCheck });
}

export function decideExitCode(decision: ExitDecision): HarnessExitCode {
  const caseExitCode = decision.proveFailure
    ? exitCodeExcludingSelfCheck(decision.report)
    : exitCodeFor(decision.report);
  if (caseExitCode !== 0) return caseExitCode;
  if (decision.proveFailure && !decision.selfCheck.ok) return EXIT_HARNESS_ERROR;
  if (!decision.survivors.available) return EXIT_HARNESS_ERROR;
  if (decision.survivors.leftoverPids.length > 0) return EXIT_HARNESS_ERROR;
  return 0;
}

export function caseKey(record: Pick<CaseRecord, 'viewport' | 'scenario'>): string {
  return `${record.viewport}--${record.scenario}`;
}

function findFailingStep(record: CaseRecord): StepRecord | null {
  return record.steps.find((step) => step.outcome === 'failed') ?? null;
}

function renderVerdictLine(report: BrowserRunReport): string {
  const totalCases = report.cases.length;
  const { passed, failed, skipped } = report.totals;
  if (failed > 0) return `FAIL ${failed} of ${totalCases} (${skipped} skipped)`;
  return `PASS ${passed}/${totalCases}`;
}

function renderSelfCheckNote(report: BrowserRunReport): string[] {
  const hasSelfCheck = report.cases.some((record) => record.scenario === PROVE_FAILURE_SCENARIO);
  if (!hasSelfCheck) return [];
  return [`${PROVE_FAILURE_SCENARIO} is expected to fail: that failure is the proof and never sets the exit code`];
}

function renderFailedStep(step: StepRecord): string[] {
  const lines = [`step ${step.index} ${step.source}`];
  const failure = step.failure;
  if (!failure) return lines;
  lines.push(`${failure.predicate}: ${failure.detail}`);
  if (failure.firstDifferingRow === null) return lines;
  lines.push(`row ${failure.firstDifferingRow}`);
  lines.push(`${FENCE}expected`, failure.expectedRow ?? '', FENCE);
  lines.push(`${FENCE}actual`, failure.actualRow ?? '', FENCE);
  return lines;
}

function renderFailedCase(record: CaseRecord): string[] {
  const lines = [`### ${record.viewport} / ${record.scenario}`, ''];
  const failingStep = findFailingStep(record);
  if (failingStep) lines.push(...renderFailedStep(failingStep));
  for (const shot of record.shots) lines.push(`shot: ${shot}`);
  const diffPath = failingStep?.failure?.diffPath ?? null;
  if (diffPath) lines.push(`diff: ${diffPath}`);
  const errorLines = [
    ...record.consoleErrors.slice(-CONSOLE_ERROR_TAIL).map((message) => `console: ${message}`),
    ...record.pageErrors.map((message) => `page: ${message}`),
  ];
  if (errorLines.length > 0) lines.push('', `${FENCE}errors`, ...errorLines, FENCE);
  lines.push('');
  return lines;
}

function renderMatrix(report: BrowserRunReport): string[] {
  const viewportsInOrder: string[] = [];
  const scenariosInOrder: string[] = [];
  const seenViewports = new Set<string>();
  const seenScenarios = new Set<string>();
  const cellByCaseKey = new Map<string, string>();
  for (const record of report.cases) {
    if (!seenViewports.has(record.viewport)) {
      seenViewports.add(record.viewport);
      viewportsInOrder.push(record.viewport);
    }
    if (!seenScenarios.has(record.scenario)) {
      seenScenarios.add(record.scenario);
      scenariosInOrder.push(record.scenario);
    }
    cellByCaseKey.set(caseKey(record), MATRIX_CELL_BY_OUTCOME[record.outcome]);
  }
  const headerCells = ['viewport', ...scenariosInOrder];
  const lines = [
    '## Matrix',
    '',
    `| ${headerCells.join(' | ')} |`,
    `| ${headerCells.map(() => '---').join(' | ')} |`,
  ];
  for (const viewport of viewportsInOrder) {
    const cells = scenariosInOrder.map(
      (scenario) => cellByCaseKey.get(caseKey({ viewport, scenario })) ?? '-',
    );
    lines.push(`| ${[viewport, ...cells].join(' | ')} |`);
  }
  lines.push('');
  return lines;
}

function renderArtifacts(report: BrowserRunReport): string[] {
  const lines = ['## Artifacts', ''];
  for (const record of report.cases) {
    for (const shot of record.shots) lines.push(`- ${shot}`);
    lines.push(`- ${record.logPath}`);
  }
  lines.push('');
  return lines;
}

export function renderMarkdown(report: BrowserRunReport): string {
  const lines = [
    `# Glimmervoid browser harness ${report.runId}`,
    '',
    renderVerdictLine(report),
    ...renderSelfCheckNote(report),
    `repoHead ${report.repoHead} node ${report.node} playwright-core ${report.playwrightCore}`,
    '',
  ];
  const failedCases = report.cases.filter((record) => record.outcome === 'failed');
  if (failedCases.length > 0) {
    lines.push('## Failures', '');
    for (const record of failedCases) lines.push(...renderFailedCase(record));
  }
  lines.push(...renderMatrix(report), ...renderArtifacts(report));
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderProveFailureCheck(report: BrowserRunReport): { ok: boolean; detail: string } {
  const proveCase = report.cases.find((record) => record.scenario === PROVE_FAILURE_SCENARIO);
  if (!proveCase) {
    return { ok: false, detail: `no case ran the ${PROVE_FAILURE_SCENARIO} scenario` };
  }
  const key = caseKey(proveCase);
  if (proveCase.outcome !== 'failed') {
    return { ok: false, detail: `${key} ended ${proveCase.outcome} but must end failed` };
  }
  const failingStep = findFailingStep(proveCase);
  if (!failingStep) {
    return { ok: false, detail: `${key} is marked failed but carries no failing step` };
  }
  const diffPath = failingStep.failure?.diffPath ?? null;
  if (!diffPath) {
    return { ok: false, detail: `${key} step ${failingStep.index} failed without a diff artifact` };
  }
  return { ok: true, detail: `${key} failed at step ${failingStep.index} with diff ${diffPath}` };
}
