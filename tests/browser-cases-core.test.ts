import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIEWPORT_HEIGHT_PX,
  MAX_VIEWPORT_WIDTH_PX,
  MIN_VIEWPORT_HEIGHT_PX,
  MIN_VIEWPORT_WIDTH_PX,
  PAIR_VIEWPORTS,
  SCENARIOS,
  VIEWPORTS,
  casesFor,
  companionFor,
  heightWithKeyboardUp,
  layoutFor,
} from '../test/browser/cases-core.ts';
import type { HarnessCase, Scenario, Step, Viewport } from '../test/browser/cases-core.ts';
import { BURST_CAP } from '../test/browser/frame-core.ts';

const DEFAULT_CASE_COUNT = 55;
const PROVE_FAILURE_CASE_COUNT = 57;

function viewportNamed(name: string): Viewport {
  const found = VIEWPORTS.find((viewport) => viewport.name === name);
  assert.ok(found, `the catalog must define the ${name} viewport`);
  return found;
}

function scenarioNamed(name: string): Scenario {
  const found = SCENARIOS.find((scenario) => scenario.name === name);
  assert.ok(found, `the catalog must define the ${name} scenario`);
  return found;
}

function lastSteadyStep(steps: readonly Step[]): Step {
  const steady = steps.filter((step) => step.kind !== 'shot');
  const last = steady.at(-1);
  assert.ok(last, 'a scenario must hold at least one step that is not a screenshot');
  return last;
}

function allSteps(cases: readonly HarnessCase[]): Step[] {
  return cases.flatMap((harnessCase) => [...harnessCase.scenario.steps]);
}

test('the default matrix is pinned so a silently dropped case fails the suite', () => {
  assert.equal(casesFor().length, DEFAULT_CASE_COUNT);
  assert.equal(casesFor({}).length, DEFAULT_CASE_COUNT);
});

test('every scenario reaches a fixpoint before the harness stops looking', () => {
  for (const scenario of SCENARIOS) {
    const last = lastSteadyStep(scenario.steps);
    assert.ok(
      last.kind === 'settle' || last.kind === 'assert-grid',
      `${scenario.name} ends on ${last.kind}, so a screenshot could catch a mid-flight grid`,
    );
  }
});

test('every settle that demands a remembered grid names one the same viewer recorded earlier', () => {
  for (const scenario of SCENARIOS) {
    const recorded = new Set<string>();
    for (const step of scenario.steps) {
      const viewer = step.viewer ?? 'a';
      if (step.kind === 'remember') recorded.add(`${viewer}:${step.label}`);
      if (step.kind !== 'settle' || step.expectRemembered === undefined) continue;
      assert.ok(
        recorded.has(`${viewer}:${step.expectRemembered}`),
        `${scenario.name} settles at ${step.expectRemembered} before viewer ${viewer} remembered it`,
      );
    }
  }
});

test('a phone-only scenario is never paired with a desktop layout viewport', () => {
  for (const harnessCase of casesFor({ proveFailure: true })) {
    if (harnessCase.scenario.phoneOnly !== true) continue;
    assert.equal(harnessCase.expectedLayout, 'phone', `${harnessCase.scenario.name} on ${harnessCase.viewport.name}`);
  }
});

test('layout follows the one width threshold the dashboard itself evaluates', () => {
  assert.equal(layoutFor(viewportNamed('tablet-820')), 'desktop');
  assert.equal(layoutFor(viewportNamed('phone-landscape')), 'desktop');
  assert.equal(layoutFor(viewportNamed('phone-393')), 'phone');
  assert.equal(layoutFor(viewportNamed('desktop-800')), 'desktop');
});

test('the failure prover is excluded by default and included behind its flag', () => {
  const byDefault = casesFor();
  assert.equal(
    byDefault.some((harnessCase) => harnessCase.scenario.proveFailure === true),
    false,
  );
  const proving = casesFor({ proveFailure: true });
  assert.equal(proving.length, PROVE_FAILURE_CASE_COUNT);
  const proven = proving.filter((harnessCase) => harnessCase.scenario.name === 'self-check-must-fail');
  assert.deepEqual(
    proven.map((harnessCase) => harnessCase.viewport.name),
    [PAIR_VIEWPORTS[0], PAIR_VIEWPORTS[1]],
  );
});

test('only filters scenarios and viewportNames filters viewports', () => {
  const keyboardOnly = casesFor({ only: ['keyboard'] });
  assert.deepEqual(
    keyboardOnly.map((harnessCase) => harnessCase.viewport.name),
    ['phone-375', 'phone-393', 'phone-412'],
  );
  const keyboardRestore = casesFor({ only: ['keyboard-restores-grid'] });
  assert.deepEqual(
    keyboardRestore.map((harnessCase) => harnessCase.viewport.name),
    ['phone-375', 'phone-393', 'phone-412'],
  );
  const onePhone = casesFor({ viewportNames: ['phone-393'] });
  assert.equal(
    onePhone.every((harnessCase) => harnessCase.viewport.name === 'phone-393'),
    true,
  );
  const single = casesFor({ only: ['cold-open'], viewportNames: ['desktop-1920'] });
  assert.equal(single.length, 1);
  assert.equal(single[0]?.scenario.name, 'cold-open');
  assert.equal(casesFor({ only: ['no-such-scenario'] }).length, 0);
  assert.equal(casesFor({ viewportNames: ['no-such-viewport'] }).length, 0);
});

test('a soft keyboard step never runs on a viewport with no keyboard height', () => {
  for (const harnessCase of casesFor({ proveFailure: true })) {
    const usesKeyboard = harnessCase.scenario.steps.some((step) => step.kind === 'keyboard');
    if (!usesKeyboard) continue;
    assert.notEqual(harnessCase.viewport.keyboardHeight, undefined, harnessCase.viewport.name);
  }
});

test('no burst asks for more lines than the relay is pinned to carry', () => {
  for (const step of allSteps(casesFor({ proveFailure: true }))) {
    if (step.kind !== 'burst') continue;
    assert.ok(step.lines > 0 && step.lines <= BURST_CAP, `burst of ${step.lines}`);
  }
  assert.equal(scenarioNamed('burst-during-resize').steps.some((step) => step.kind === 'burst'), true);
});

test('every burst is followed on its own viewer by a settle that can demand the new tick', () => {
  for (const harnessCase of casesFor({ proveFailure: true })) {
    const steps = harnessCase.scenario.steps;
    for (const [index, step] of steps.entries()) {
      if (step.kind !== 'burst') continue;
      const burstViewer = step.viewer ?? 'a';
      const nextTickConsumer = steps
        .slice(index + 1)
        .find((later) => (later.kind === 'settle' || later.kind === 'burst') && (later.viewer ?? 'a') === burstViewer);
      assert.equal(
        nextTickConsumer?.kind,
        'settle',
        `${harnessCase.scenario.name} bursts on viewer ${burstViewer} without a settle on that viewer to check the tick moved`,
      );
    }
  }
});

test('every resolved resize is a window size Chromium can actually take', () => {
  const resizes = allSteps(casesFor({ proveFailure: true })).filter((step) => step.kind === 'resize');
  assert.ok(resizes.length > 0, 'the storm scenarios must resolve to concrete resizes');
  for (const step of resizes) {
    if (step.kind !== 'resize') continue;
    assert.ok(
      step.width >= MIN_VIEWPORT_WIDTH_PX && step.width <= MAX_VIEWPORT_WIDTH_PX,
      `width ${step.width}`,
    );
    assert.ok(
      step.height >= MIN_VIEWPORT_HEIGHT_PX && step.height <= MAX_VIEWPORT_HEIGHT_PX,
      `height ${step.height}`,
    );
  }
});

test('every catalog viewport sits inside the resize bounds, so a zero delta restores it', () => {
  for (const viewport of VIEWPORTS) {
    assert.ok(
      viewport.width >= MIN_VIEWPORT_WIDTH_PX && viewport.width <= MAX_VIEWPORT_WIDTH_PX,
      `${viewport.name} width ${viewport.width}`,
    );
    assert.ok(
      viewport.height >= MIN_VIEWPORT_HEIGHT_PX && viewport.height <= MAX_VIEWPORT_HEIGHT_PX,
      `${viewport.name} height ${viewport.height}`,
    );
  }
  for (const harnessCase of casesFor({ only: ['resize-storm'] })) {
    const resizes = harnessCase.scenario.steps.flatMap((step) => (step.kind === 'resize' ? [step] : []));
    const closingResize = resizes.at(-1);
    assert.ok(closingResize, `${harnessCase.viewport.name} resolves no resize`);
    assert.deepEqual(
      [closingResize.width, closingResize.height],
      [harnessCase.viewport.width, harnessCase.viewport.height],
      `${harnessCase.viewport.name} never returns to its own size`,
    );
  }
});

test('raising the soft keyboard resolves to a height Chromium can actually take', () => {
  for (const viewport of VIEWPORTS) {
    const keyboardHeight = viewport.keyboardHeight;
    if (keyboardHeight === undefined) continue;
    const raised = heightWithKeyboardUp(viewport.height, keyboardHeight);
    assert.ok(
      raised >= MIN_VIEWPORT_HEIGHT_PX && raised <= MAX_VIEWPORT_HEIGHT_PX,
      `${viewport.name} keyboard height ${raised}`,
    );
    assert.ok(raised < viewport.height, `${viewport.name} keyboard height ${raised}`);
  }
  assert.equal(heightWithKeyboardUp(667, 300), 367);
  assert.equal(heightWithKeyboardUp(400, 900), MIN_VIEWPORT_HEIGHT_PX);
  assert.equal(heightWithKeyboardUp(MAX_VIEWPORT_HEIGHT_PX + 500, 100), MAX_VIEWPORT_HEIGHT_PX);
});

test('the shortest catalog viewport still storms through distinct heights below its own', () => {
  const landscapeStorm = casesFor({ only: ['resize-storm'], viewportNames: ['phone-landscape'] })[0];
  assert.ok(landscapeStorm);
  const shorterHeights = landscapeStorm.scenario.steps.flatMap(
    (step) => (step.kind === 'resize' && step.height < landscapeStorm.viewport.height ? [step.height] : []),
  );
  assert.ok(new Set(shorterHeights).size >= 2, `heights ${shorterHeights.join(', ')}`);
});

test('resolution leaves no relative resize for the driver to interpret', () => {
  for (const step of allSteps(casesFor({ proveFailure: true }))) {
    assert.notEqual(step.kind, 'resize-by');
  }
});

test('a phone keeps its device width while a desktop window storms both axes', () => {
  const phoneStorm = casesFor({ only: ['resize-storm'], viewportNames: ['phone-412'] })[0];
  assert.ok(phoneStorm);
  for (const step of phoneStorm.scenario.steps) {
    if (step.kind !== 'resize') continue;
    assert.equal(step.width, 412);
  }
  const desktopStorm = casesFor({ only: ['resize-storm'], viewportNames: ['desktop-800'] })[0];
  assert.ok(desktopStorm);
  const desktopWidths = desktopStorm.scenario.steps.flatMap((step) => (step.kind === 'resize' ? [step.width] : []));
  assert.equal(new Set(desktopWidths).size > 1, true);
});

test('the two viewer scenario always pairs a case with the opposite pair viewport', () => {
  const twoViewers = casesFor({ only: ['two-viewers'], proveFailure: true });
  assert.deepEqual(
    twoViewers.map((harnessCase) => [harnessCase.viewport.name, harnessCase.companion?.name]),
    [
      [PAIR_VIEWPORTS[0], PAIR_VIEWPORTS[1]],
      [PAIR_VIEWPORTS[1], PAIR_VIEWPORTS[0]],
    ],
  );
  assert.equal(companionFor(viewportNamed('phone-375'), scenarioNamed('cold-open')), null);
});

test('a case with no companion scenario carries no companion viewport', () => {
  for (const harnessCase of casesFor({ proveFailure: true })) {
    if (harnessCase.scenario.companionViewport !== undefined) continue;
    assert.equal(harnessCase.companion, null, harnessCase.scenario.name);
  }
});

test('cases come out in viewport order then scenario order', () => {
  const viewportOrder = casesFor().map((harnessCase) => VIEWPORTS.indexOf(harnessCase.viewport));
  assert.deepEqual(viewportOrder, [...viewportOrder].sort((left, right) => left - right));
  const firstViewportScenarios = casesFor({ viewportNames: ['phone-393'] }).map(
    (harnessCase) => harnessCase.scenario.name,
  );
  assert.deepEqual(firstViewportScenarios, [
    'cold-open',
    'reopen-x3',
    'resize-storm',
    'keyboard',
    'two-viewers',
    'offline-online',
    'burst-during-resize',
    'plan-face',
    'h1-desktop-first',
    'h2-companion-reconnect',
    'h2-viewer-reconnect',
    'h3-reopen-with-companion',
    'h4-companion-resize',
    'h8-plan-face-return',
    'h9-desktop-refocus',
    'h10-blur-during-settle',
    'keyboard-restores-grid',
    'keyboard-down-while-unengaged',
    'reconnect-while-backgrounded',
    'keyboard-down-with-focus-in-card',
    'blurred-viewer-never-steals',
  ]);
});

test('a scenario pinned to named viewports runs on those and nowhere else', () => {
  const pinned = scenarioNamed('h6-layout-flip');
  assert.deepEqual(pinned.viewports, ['touch-1024']);
  const ran = casesFor({ proveFailure: true })
    .filter((harnessCase) => harnessCase.scenario.name === pinned.name)
    .map((harnessCase) => harnessCase.viewport.name);
  assert.deepEqual(ran, ['touch-1024']);
});

test('every scenario name is unique and every viewport name is unique', () => {
  assert.equal(new Set(SCENARIOS.map((scenario) => scenario.name)).size, SCENARIOS.length);
  assert.equal(new Set(VIEWPORTS.map((viewport) => viewport.name)).size, VIEWPORTS.length);
  assert.equal(VIEWPORTS.filter((viewport) => PAIR_VIEWPORTS.includes(viewport.name)).length, 2);
});
