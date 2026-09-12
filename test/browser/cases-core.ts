import { PHONE_MAX_WIDTH_PX, decideLayout } from '../../public/form-factor-core.ts';

export type ViewerId = 'a' | 'b';

export type CardControl = 'plan-terminal';

export type Step =
  | { kind: 'open'; viewer?: ViewerId }
  | { kind: 'back'; viewer?: ViewerId }
  | { kind: 'resize'; width: number; height: number; viewer?: ViewerId }
  | { kind: 'resize-by'; deltaWidth?: number; deltaHeight?: number; viewer?: ViewerId }
  | { kind: 'keyboard'; state: 'up' | 'down'; viewer?: ViewerId }
  | { kind: 'type'; text: string; viewer?: ViewerId }
  | { kind: 'burst'; lines: number; viewer?: ViewerId }
  | { kind: 'offline'; viewer?: ViewerId }
  | { kind: 'online'; viewer?: ViewerId }
  | { kind: 'foreground'; quiet?: boolean; viewer?: ViewerId }
  | { kind: 'wait'; durationMs: number; viewer?: ViewerId }
  | { kind: 'background'; quiet?: boolean; viewer?: ViewerId }
  | { kind: 'window-blur'; viewer?: ViewerId }
  | { kind: 'tap-terminal'; viewer?: ViewerId }
  | { kind: 'remember'; label: string; viewer?: ViewerId }
  | { kind: 'settle'; viewer?: ViewerId; expectGrid?: 'exact' | 'following'; expectRemembered?: string }
  | { kind: 'assert-grid'; viewer?: ViewerId; tickOffset?: number }
  | { kind: 'expect-face'; value: 'plan' | 'terminal'; viewer?: ViewerId }
  | { kind: 'click'; control: CardControl; viewer?: ViewerId }
  | { kind: 'shot'; name: string; viewer?: ViewerId };

export type ResolvedStep = Exclude<Step, { kind: 'resize-by' }>;

export interface Viewport {
  name: string;
  width: number;
  height: number;
  hasTouch: boolean;
  isMobile: boolean;
  keyboardHeight?: number;
}

export type Layout = 'phone' | 'desktop';

export interface Scenario {
  name: string;
  steps: readonly Step[];
  phoneOnly?: boolean;
  fullMatrix?: boolean;
  optional?: boolean;
  companionViewport?: string;
  viewports?: readonly string[];
  proveFailure?: boolean;
}

export interface ResolvedScenario extends Omit<Scenario, 'steps'> {
  steps: readonly ResolvedStep[];
}

export interface HarnessCase {
  viewport: Viewport;
  scenario: ResolvedScenario;
  expectedLayout: Layout;
  companion: Viewport | null;
}

export interface CasesForOptions {
  only?: readonly string[];
  viewportNames?: readonly string[];
  proveFailure?: boolean;
}

export const MIN_VIEWPORT_WIDTH_PX = 320;
export const MAX_VIEWPORT_WIDTH_PX = 1920;
export const MIN_VIEWPORT_HEIGHT_PX = 300;
export const MAX_VIEWPORT_HEIGHT_PX = 1200;

export const VIEWPORTS: readonly Viewport[] = [
  { name: 'phone-375', width: 375, height: 667, hasTouch: true, isMobile: true, keyboardHeight: 300 },
  { name: 'phone-393', width: 393, height: 852, hasTouch: true, isMobile: true, keyboardHeight: 400 },
  { name: 'phone-412', width: 412, height: 915, hasTouch: true, isMobile: true, keyboardHeight: 420 },
  { name: 'phone-landscape', width: 852, height: 393, hasTouch: true, isMobile: true },
  { name: 'tablet-820', width: 820, height: 1180, hasTouch: true, isMobile: true },
  { name: 'desktop-800', width: 800, height: 600, hasTouch: false, isMobile: false },
  { name: 'desktop-1280', width: 1280, height: 720, hasTouch: false, isMobile: false },
  { name: 'desktop-1920', width: 1920, height: 1080, hasTouch: false, isMobile: false },
  { name: 'touch-1024', width: 1024, height: 768, hasTouch: true, isMobile: false },
];

export const PAIR_VIEWPORTS: readonly [string, string] = ['phone-393', 'desktop-1280'];

const WITHIN_GRID_SETTLE_MS = 60;
const PAST_GRID_SETTLE_MS = 600;

const RESIZE_STORM_STEPS: readonly Step[] = [
  { kind: 'resize-by', deltaHeight: -40 },
  { kind: 'resize-by', deltaHeight: -80 },
  { kind: 'resize-by', deltaWidth: 20 },
  { kind: 'resize-by', deltaWidth: -60, deltaHeight: -40 },
  { kind: 'resize-by', deltaHeight: 40 },
  { kind: 'resize-by', deltaWidth: 0, deltaHeight: 0 },
];

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'cold-open',
    fullMatrix: true,
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'shot', name: 'open' }],
  },
  {
    name: 'reopen-x3',
    phoneOnly: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'back' },
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'back' },
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'shot', name: 'reopened' },
    ],
  },
  {
    name: 'resize-storm',
    fullMatrix: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      ...RESIZE_STORM_STEPS,
      { kind: 'settle' },
      { kind: 'shot', name: 'stormed' },
    ],
  },
  {
    name: 'keyboard',
    phoneOnly: true,
    fullMatrix: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'keyboard', state: 'up' },
      { kind: 'settle' },
      { kind: 'shot', name: 'keyboard-up' },
      { kind: 'keyboard', state: 'down' },
      { kind: 'settle' },
    ],
  },
  {
    name: 'two-viewers',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a' },
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'a', expectGrid: 'following' },
      { kind: 'background', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'shot', name: 'both' },
      { kind: 'back', viewer: 'a' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'shot', name: 'reclaimed' },
    ],
  },
  {
    name: 'offline-online',
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'offline' },
      { kind: 'online' },
      { kind: 'settle' },
      { kind: 'shot', name: 'reattached' },
    ],
  },
  {
    name: 'burst-during-resize',
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'burst', lines: 800 },
      { kind: 'resize-by', deltaHeight: -60 },
      { kind: 'resize-by', deltaHeight: 60 },
      { kind: 'settle' },
      { kind: 'shot', name: 'after-burst' },
    ],
  },
  {
    name: 'plan-face',
    optional: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'type', text: 'plan' },
      { kind: 'expect-face', value: 'plan' },
      { kind: 'settle' },
      { kind: 'shot', name: 'plan' },
    ],
  },
  {
    name: 'h1-desktop-first',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'b', expectGrid: 'following' },
    ],
  },
  {
    name: 'h2-companion-reconnect',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'background', viewer: 'b' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'offline', viewer: 'b' },
      { kind: 'online', viewer: 'b' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
    ],
  },
  {
    name: 'h2-viewer-reconnect',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'offline', viewer: 'a' },
      { kind: 'online', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
    ],
  },
  {
    name: 'h3-reopen-with-companion',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'back', viewer: 'a' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
    ],
  },
  {
    name: 'h4-companion-resize',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'background', viewer: 'b' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'resize', width: 1100, height: 700, viewer: 'b' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
    ],
  },
  {
    name: 'h6-layout-flip',
    viewports: ['touch-1024'],
    steps: [
      { kind: 'open' },
      { kind: 'settle', expectGrid: 'exact' },
      { kind: 'resize', width: 393, height: 852 },
      { kind: 'settle', expectGrid: 'exact' },
    ],
  },
  {
    name: 'h8-plan-face-return',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'resize', width: 1100, height: 700, viewer: 'b' },
      { kind: 'settle', viewer: 'a', expectGrid: 'following' },
      { kind: 'type', text: 'plan', viewer: 'a' },
      { kind: 'expect-face', value: 'plan', viewer: 'a' },
      { kind: 'click', control: 'plan-terminal', viewer: 'a' },
      { kind: 'expect-face', value: 'terminal', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
    ],
  },
  {
    name: 'h9-desktop-refocus',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'background', viewer: 'b' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'b', expectGrid: 'following' },
      { kind: 'background', viewer: 'a' },
      { kind: 'foreground', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'a', expectGrid: 'following' },
      { kind: 'background', viewer: 'b' },
      { kind: 'foreground', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'b', expectGrid: 'following' },
    ],
  },
  {
    name: 'h10-blur-during-settle',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'background', viewer: 'b' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'foreground', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'resize', width: 1100, height: 700, viewer: 'b' },
      { kind: 'wait', durationMs: WITHIN_GRID_SETTLE_MS, viewer: 'b' },
      { kind: 'background', viewer: 'b' },
      { kind: 'foreground', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
    ],
  },
  {
    name: 'keyboard-restores-grid',
    phoneOnly: true,
    fullMatrix: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'remember', label: 'phone-box' },
      { kind: 'tap-terminal' },
      { kind: 'keyboard', state: 'up' },
      { kind: 'settle' },
      { kind: 'keyboard', state: 'down' },
      { kind: 'settle', expectRemembered: 'phone-box' },
    ],
  },
  {
    name: 'keyboard-down-while-unengaged',
    phoneOnly: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'remember', label: 'phone-box' },
      { kind: 'keyboard', state: 'up' },
      { kind: 'settle' },
      { kind: 'background' },
      { kind: 'keyboard', state: 'down' },
      { kind: 'wait', durationMs: PAST_GRID_SETTLE_MS },
      { kind: 'foreground' },
      { kind: 'settle', expectRemembered: 'phone-box' },
      { kind: 'shot', name: 'keyboard-down-unengaged' },
    ],
  },
  {
    name: 'reconnect-while-backgrounded',
    phoneOnly: true,
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a' },
      { kind: 'remember', label: 'phone-box', viewer: 'a' },
      { kind: 'background', viewer: 'a' },
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'offline', viewer: 'a' },
      { kind: 'online', viewer: 'a' },
      { kind: 'foreground', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectRemembered: 'phone-box' },
      { kind: 'shot', name: 'reattached-unengaged' },
    ],
  },
  {
    name: 'keyboard-down-with-focus-in-card',
    phoneOnly: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'remember', label: 'phone-box' },
      { kind: 'tap-terminal' },
      { kind: 'keyboard', state: 'up' },
      { kind: 'settle' },
      { kind: 'background', quiet: true },
      { kind: 'keyboard', state: 'down' },
      { kind: 'settle', expectRemembered: 'phone-box' },
      { kind: 'shot', name: 'keyboard-down-focused' },
    ],
  },
  {
    name: 'blurred-viewer-never-steals',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'tap-terminal', viewer: 'b' },
      { kind: 'window-blur', viewer: 'b' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'offline', viewer: 'b' },
      { kind: 'online', viewer: 'b' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'b', expectGrid: 'following' },
    ],
  },
  {
    name: 'self-check-must-fail',
    proveFailure: true,
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'assert-grid', tickOffset: 1 }],
  },
];

export function layoutFor(viewport: Viewport): Layout {
  return decideLayout({ coarse: viewport.hasTouch, narrowWidth: viewport.width <= PHONE_MAX_WIDTH_PX });
}

function clampToRange(value: number, minimum: number, maximum: number): number {
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

function resolveStepForViewport(step: Step, viewport: Viewport, layout: Layout): ResolvedStep {
  if (step.kind !== 'resize-by') return step;
  const widthDelta = layout === 'desktop' ? (step.deltaWidth ?? 0) : 0;
  const heightDelta = step.deltaHeight ?? 0;
  return {
    kind: 'resize',
    width: clampToRange(viewport.width + widthDelta, MIN_VIEWPORT_WIDTH_PX, MAX_VIEWPORT_WIDTH_PX),
    height: clampToRange(viewport.height + heightDelta, MIN_VIEWPORT_HEIGHT_PX, MAX_VIEWPORT_HEIGHT_PX),
    viewer: step.viewer,
  };
}

export function heightWithKeyboardUp(currentHeightPx: number, keyboardHeightPx: number): number {
  return clampToRange(currentHeightPx - keyboardHeightPx, MIN_VIEWPORT_HEIGHT_PX, MAX_VIEWPORT_HEIGHT_PX);
}

function viewportNamed(name: string): Viewport | null {
  return VIEWPORTS.find((viewport) => viewport.name === name) ?? null;
}

function otherPairViewportName(name: string): string {
  if (name === PAIR_VIEWPORTS[0]) return PAIR_VIEWPORTS[1];
  return PAIR_VIEWPORTS[0];
}

export function companionFor(viewport: Viewport, scenario: Scenario): Viewport | null {
  const declared = scenario.companionViewport;
  if (declared === undefined) return null;
  if (declared === viewport.name) return viewportNamed(otherPairViewportName(viewport.name));
  return viewportNamed(declared);
}

function needsSoftKeyboard(scenario: Scenario): boolean {
  return scenario.steps.some((step) => step.kind === 'keyboard');
}

function scenarioRunsOnViewport(scenario: Scenario, viewport: Viewport, layout: Layout, proveFailure: boolean): boolean {
  if (scenario.proveFailure === true && !proveFailure) return false;
  if (scenario.phoneOnly === true && layout !== 'phone') return false;
  if (needsSoftKeyboard(scenario) && viewport.keyboardHeight === undefined) return false;
  if (scenario.viewports) return scenario.viewports.includes(viewport.name);
  if (scenario.fullMatrix === true) return true;
  return PAIR_VIEWPORTS.includes(viewport.name);
}

export function casesFor(options: CasesForOptions = {}): HarnessCase[] {
  const wantedViewportNames = options.viewportNames;
  const wantedScenarioNames = options.only;
  const selectedViewports = wantedViewportNames
    ? VIEWPORTS.filter((viewport) => wantedViewportNames.includes(viewport.name))
    : VIEWPORTS;
  const selectedScenarios = wantedScenarioNames
    ? SCENARIOS.filter((scenario) => wantedScenarioNames.includes(scenario.name))
    : SCENARIOS;
  const proveFailure = options.proveFailure === true;
  const resolved: HarnessCase[] = [];
  for (const viewport of selectedViewports) {
    const expectedLayout = layoutFor(viewport);
    for (const scenario of selectedScenarios) {
      if (!scenarioRunsOnViewport(scenario, viewport, expectedLayout, proveFailure)) continue;
      resolved.push({
        viewport,
        scenario: {
          ...scenario,
          steps: scenario.steps.map((step) => resolveStepForViewport(step, viewport, expectedLayout)),
        },
        expectedLayout,
        companion: companionFor(viewport, scenario),
      });
    }
  }
  return resolved;
}
