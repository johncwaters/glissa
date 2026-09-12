import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  BrowserRunReport,
  CaseRecord,
  StepRecord,
} from '../test/browser/report-core.ts';
import {
  EXIT_HARNESS_ERROR,
  PROVE_FAILURE_SCENARIO,
  caseKey,
  decideExitCode,
  exitCodeExcludingSelfCheck,
  exitCodeFor,
  renderMarkdown,
  renderProveFailureCheck,
  summarize,
} from '../test/browser/report-core.ts';

function passedStep(index: number, source: string, shot: string | null): StepRecord {
  return { index, source, outcome: 'passed', durationMs: 11, grid: null, failure: null, shot };
}

function failedStep(index: number, source: string, diffPath: string | null): StepRecord {
  return {
    index,
    source,
    outcome: 'failed',
    durationMs: 23,
    grid: { cols: 120, rows: 40, tick: 7, dataGrid: 'ready', face: 'idle', bufferLength: 4096 },
    failure: {
      predicate: 'gridMatchesSnapshot',
      detail: 'the attached terminal never repainted row 12',
      firstDifferingRow: 12,
      expectedRow: 'glimmervoid> npm test',
      actualRow: 'glimmervoid>',
      diffPath,
    },
    shot: null,
  };
}

function buildCase(overrides: Partial<CaseRecord> & Pick<CaseRecord, 'viewport' | 'scenario'>): CaseRecord {
  return {
    width: 1440,
    height: 900,
    expectedLayout: 'desktop',
    observedLayout: 'desktop',
    optional: false,
    outcome: 'passed',
    durationMs: 400,
    steps: [],
    shots: [],
    logPath: `logs/${caseKey(overrides)}.log`,
    consoleErrors: [],
    pageErrors: [],
    ...overrides,
  };
}

const passedCase = buildCase({
  viewport: 'phone',
  width: 390,
  height: 844,
  expectedLayout: 'phone',
  observedLayout: 'phone',
  scenario: 'boot',
  outcome: 'passed',
  steps: [passedStep(0, 'openDashboard', 'shots/phone--boot-0.png'), passedStep(1, 'attachSession', 'shots/phone--boot-1.png')],
  shots: ['shots/phone--boot-0.png', 'shots/phone--boot-1.png'],
});

const failedCase = buildCase({
  viewport: 'desktop',
  scenario: 'attach',
  outcome: 'failed',
  steps: [passedStep(0, 'openDashboard', null), failedStep(1, 'expectGridSettled', 'diffs/desktop--attach.png')],
  shots: ['shots/desktop--attach-0.png'],
  consoleErrors: ['one', 'two', 'three', 'four', 'five', 'six'],
  pageErrors: ['TypeError: cannot read property cols of null'],
});

const skippedOptionalCase = buildCase({
  viewport: 'desktop',
  scenario: 'webgl-stress',
  optional: true,
  outcome: 'skipped',
  steps: [],
  shots: [],
});

function buildReport(cases: CaseRecord[]): BrowserRunReport {
  return {
    version: 1,
    runId: 'run-2026-09-10-01',
    startedAt: 1_000,
    finishedAt: 9_000,
    repoHead: '374d27b',
    node: 'v24.4.0',
    playwrightCore: '1.55.0',
    totals: summarize(cases),
    cases,
  };
}

const fixtureReport = buildReport([passedCase, failedCase, skippedOptionalCase]);

function sectionOf(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  if (end === -1) return rest;
  return rest.slice(0, end);
}

test('summarize counts every case by its recorded outcome', () => {
  assert.deepEqual(summarize(fixtureReport.cases), { passed: 1, failed: 1, skipped: 1 });
  assert.deepEqual(summarize([]), { passed: 0, failed: 0, skipped: 0 });
});

test('a failed required case exits 1 and an all-green run exits 0', () => {
  assert.equal(exitCodeFor(fixtureReport), 1);
  const greenReport = buildReport([passedCase, buildCase({ viewport: 'desktop', scenario: 'attach' }), skippedOptionalCase]);
  assert.equal(exitCodeFor(greenReport), 0);
});

test('an optional case recorded as failed does not sink the run', () => {
  const optionalFailure = buildCase({ viewport: 'desktop', scenario: 'webgl-stress', optional: true, outcome: 'failed' });
  assert.equal(exitCodeFor(buildReport([passedCase, optionalFailure])), 0);
});

test('caseKey joins viewport and scenario with a double hyphen', () => {
  assert.equal(caseKey({ viewport: 'phone', scenario: 'boot' }), 'phone--boot');
  assert.equal(caseKey(failedCase), 'desktop--attach');
});

test('the markdown opens with the run heading and the failure verdict', () => {
  const markdown = renderMarkdown(fixtureReport);
  const lines = markdown.split('\n');
  assert.equal(lines[0], '# Glimmervoid browser harness run-2026-09-10-01');
  assert.equal(lines[2], 'FAIL 1 of 3 (1 skipped)');
  assert.equal(lines[3], 'repoHead 374d27b node v24.4.0 playwright-core 1.55.0');
});

test('a green run reports the pass verdict instead', () => {
  const markdown = renderMarkdown(buildReport([passedCase, skippedOptionalCase]));
  assert.equal(markdown.split('\n')[2], 'PASS 1/2');
  assert.equal(markdown.includes('## Failures'), false);
});

test('failures are rendered before the matrix with the row diff and artifact paths', () => {
  const markdown = renderMarkdown(fixtureReport);
  assert.ok(markdown.indexOf('## Failures') < markdown.indexOf('## Matrix'));
  const failures = sectionOf(markdown, '## Failures').join('\n');
  assert.ok(failures.includes('### desktop / attach'));
  assert.ok(failures.includes('step 1 expectGridSettled'));
  assert.ok(failures.includes('gridMatchesSnapshot: the attached terminal never repainted row 12'));
  assert.ok(failures.includes('row 12'));
  assert.ok(failures.includes('```expected\nglimmervoid> npm test\n```'));
  assert.ok(failures.includes('```actual\nglimmervoid>\n```'));
  assert.ok(failures.includes('shot: shots/desktop--attach-0.png'));
  assert.ok(failures.includes('diff: diffs/desktop--attach.png'));
});

test('the failure block keeps the last five console errors and every page error', () => {
  const failures = sectionOf(renderMarkdown(fixtureReport), '## Failures').join('\n');
  assert.equal(failures.includes('console: one'), false);
  assert.ok(failures.includes('console: two'));
  assert.ok(failures.includes('console: six'));
  assert.ok(failures.includes('page: TypeError: cannot read property cols of null'));
});

test('the matrix carries one row per viewport and a dash for pairs that never ran', () => {
  const matrixLines = sectionOf(renderMarkdown(fixtureReport), '## Matrix').filter((line) => line.startsWith('|'));
  assert.equal(matrixLines[0], '| viewport | boot | attach | webgl-stress |');
  assert.equal(matrixLines[1], '| --- | --- | --- | --- |');
  const rows = matrixLines.slice(2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0], '| phone | ok | - | - |');
  assert.equal(rows[1], '| desktop | - | FAIL | skip |');
});

test('every shot and log path is listed under artifacts in case order', () => {
  const artifacts = sectionOf(renderMarkdown(fixtureReport), '## Artifacts').filter((line) => line.startsWith('- '));
  assert.deepEqual(artifacts, [
    '- shots/phone--boot-0.png',
    '- shots/phone--boot-1.png',
    '- logs/phone--boot.log',
    '- shots/desktop--attach-0.png',
    '- logs/desktop--attach.log',
    '- logs/desktop--webgl-stress.log',
  ]);
  for (const shot of [...passedCase.shots, ...failedCase.shots]) {
    assert.ok(artifacts.includes(`- ${shot}`));
  }
});

test('the self-check failure never sets the exit code and the report says so', () => {
  const proveCase = buildCase({
    viewport: 'phone-393',
    scenario: PROVE_FAILURE_SCENARIO,
    outcome: 'failed',
    steps: [failedStep(0, 'expectImpossibleRow', 'diffs/self-check.png')],
  });
  const proving = buildReport([passedCase, proveCase]);
  assert.equal(exitCodeFor(proving), 1);
  assert.equal(exitCodeExcludingSelfCheck(proving), 0);
  assert.equal(exitCodeExcludingSelfCheck(buildReport([failedCase, proveCase])), 1);
  assert.equal(
    renderMarkdown(proving).split('\n')[3],
    `${PROVE_FAILURE_SCENARIO} is expected to fail: that failure is the proof and never sets the exit code`,
  );
  assert.equal(renderMarkdown(fixtureReport).includes('is expected to fail'), false);
});

test('the prove-failure check passes when the self-check case failed with a diff', () => {
  const proveCase = buildCase({
    viewport: 'desktop',
    scenario: PROVE_FAILURE_SCENARIO,
    outcome: 'failed',
    steps: [failedStep(0, 'expectImpossibleRow', 'diffs/self-check.png')],
  });
  const check = renderProveFailureCheck(buildReport([proveCase]));
  assert.equal(check.ok, true);
  assert.ok(check.detail.includes('diffs/self-check.png'));
});

test('the prove-failure check reports why the self-check did not bite', () => {
  const missing = renderProveFailureCheck(fixtureReport);
  assert.equal(missing.ok, false);
  assert.ok(missing.detail.includes(PROVE_FAILURE_SCENARIO));

  const passedSelfCheck = buildCase({ viewport: 'desktop', scenario: PROVE_FAILURE_SCENARIO, outcome: 'passed' });
  assert.deepEqual(renderProveFailureCheck(buildReport([passedSelfCheck])), {
    ok: false,
    detail: 'desktop--self-check-must-fail ended passed but must end failed',
  });

  const noStep = buildCase({ viewport: 'desktop', scenario: PROVE_FAILURE_SCENARIO, outcome: 'failed' });
  assert.deepEqual(renderProveFailureCheck(buildReport([noStep])), {
    ok: false,
    detail: 'desktop--self-check-must-fail is marked failed but carries no failing step',
  });

  const noDiff = buildCase({
    viewport: 'desktop',
    scenario: PROVE_FAILURE_SCENARIO,
    outcome: 'failed',
    steps: [failedStep(0, 'expectImpossibleRow', null)],
  });
  const withoutDiff = renderProveFailureCheck(buildReport([noDiff]));
  assert.equal(withoutDiff.ok, false);
  assert.ok(withoutDiff.detail.includes('without a diff artifact'));
});

const scanFoundNoSurvivors = { available: true, leftoverPids: [] };
const scanCouldNotRun = { available: false, leftoverPids: [] };
const scanFoundSurvivors = { available: true, leftoverPids: [4242, 4243] };
const selfCheckOk = { ok: true };
const selfCheckNotOk = { ok: false };

const cleanReport = buildReport([passedCase, skippedOptionalCase]);
const failingReport = buildReport([passedCase, failedCase]);
const provingReport = buildReport([
  passedCase,
  buildCase({
    viewport: 'phone-393',
    scenario: PROVE_FAILURE_SCENARIO,
    outcome: 'failed',
    steps: [failedStep(0, 'expectImpossibleRow', 'diffs/self-check.png')],
  }),
]);

test('a clean run with a clean survivor scan is the only way to exit zero', () => {
  assert.equal(
    decideExitCode({ report: cleanReport, proveFailure: false, selfCheck: selfCheckOk, survivors: scanFoundNoSurvivors }),
    0,
  );
});

test('a blocking case failure outranks every harness level check', () => {
  assert.equal(
    decideExitCode({ report: failingReport, proveFailure: false, selfCheck: selfCheckOk, survivors: scanFoundNoSurvivors }),
    1,
  );
  assert.equal(
    decideExitCode({ report: failingReport, proveFailure: true, selfCheck: selfCheckNotOk, survivors: scanFoundSurvivors }),
    1,
  );
});

test('under the failure prover the self check failure is discounted but its verdict still decides', () => {
  assert.equal(
    decideExitCode({ report: provingReport, proveFailure: true, selfCheck: selfCheckOk, survivors: scanFoundNoSurvivors }),
    0,
  );
  assert.equal(
    decideExitCode({ report: provingReport, proveFailure: true, selfCheck: selfCheckNotOk, survivors: scanFoundNoSurvivors }),
    EXIT_HARNESS_ERROR,
  );
  assert.equal(
    decideExitCode({ report: provingReport, proveFailure: false, selfCheck: selfCheckOk, survivors: scanFoundNoSurvivors }),
    1,
  );
});

test('a self check verdict outside the failure prover run never reaches the exit code', () => {
  assert.equal(
    decideExitCode({ report: cleanReport, proveFailure: false, selfCheck: selfCheckNotOk, survivors: scanFoundNoSurvivors }),
    0,
  );
});

test('surviving fake agents sink an otherwise clean run', () => {
  assert.equal(
    decideExitCode({ report: cleanReport, proveFailure: false, selfCheck: selfCheckOk, survivors: scanFoundSurvivors }),
    EXIT_HARNESS_ERROR,
  );
});

test('a survivor scan that could not run is never read as a clean result', () => {
  assert.equal(
    decideExitCode({ report: cleanReport, proveFailure: false, selfCheck: selfCheckOk, survivors: scanCouldNotRun }),
    EXIT_HARNESS_ERROR,
  );
  assert.equal(
    decideExitCode({ report: provingReport, proveFailure: true, selfCheck: selfCheckOk, survivors: scanCouldNotRun }),
    EXIT_HARNESS_ERROR,
  );
});
