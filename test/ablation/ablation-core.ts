import { classifyPrompt } from '../../server/core/mill-metrics-core.ts';
import type { MillMetricPromptCounts } from '../../shared/contracts/mill-metrics.ts';

type ArmName = 'on' | 'off';
type ArmOutcome = 'invalid' | 'pass' | 'fail';
type PromptPayload = { ts?: unknown; state?: unknown; stateSince?: unknown } | null | undefined;
type TaskPair = { on?: unknown; off?: unknown };

const OUTCOMES = new Set<unknown>(['pass', 'fail']);
const SIGNIFICANCE_THRESHOLD = 0.05;

function armOutcome(executionError: unknown, checkPassed: unknown): ArmOutcome {
  if (executionError) return 'invalid';
  if (checkPassed) return 'pass';
  return 'fail';
}

function turnBudget(armName: ArmName, maxTurns: number): number {
  if (armName === 'on') return maxTurns + 1;
  return maxTurns;
}

function pairArmOrder(taskIndex: number, seed: number): ArmName[] {
  const isOnFirst = (taskIndex + seed - 1) % 2 === 0;
  if (isOnFirst) return ['on', 'off'];
  return ['off', 'on'];
}

function emptyPromptCounts(): MillMetricPromptCounts {
  return { interruption: 0, answer: 0, followup: 0, ambiguous: 0 };
}

function classifyObservedPrompts(promptPayloads: PromptPayload[]): MillMetricPromptCounts {
  const prompts = emptyPromptCounts();
  for (const payload of promptPayloads) {
    const timestamp = typeof payload?.ts === 'number' && Number.isFinite(payload.ts) ? payload.ts : Date.now();
    const promptClass = classifyPrompt({
      state: typeof payload?.state === 'string' ? payload.state : '',
      stateSince: typeof payload?.stateSince === 'number' && Number.isFinite(payload.stateSince) ? payload.stateSince : timestamp,
      ts: timestamp,
    });
    prompts[promptClass] += 1;
  }
  return prompts;
}

function promptCount(prompts: MillMetricPromptCounts): number {
  return Object.values(prompts).reduce((total, count) => total + count, 0);
}

function pairOutcomes(taskPairs: TaskPair[] | null | undefined) {
  if (!Array.isArray(taskPairs)) throw new TypeError('taskPairs must be an array');
  let bothPass = 0;
  let bothFail = 0;
  let onOnly = 0;
  let offOnly = 0;
  for (const taskPair of taskPairs) {
    if (!OUTCOMES.has(taskPair?.on) || !OUTCOMES.has(taskPair?.off)) {
      throw new TypeError('each task pair must contain pass or fail outcomes');
    }
    if (taskPair.on === 'pass' && taskPair.off === 'pass') {
      bothPass += 1;
      continue;
    }
    if (taskPair.on === 'fail' && taskPair.off === 'fail') {
      bothFail += 1;
      continue;
    }
    if (taskPair.on === 'pass') {
      onOnly += 1;
      continue;
    }
    offOnly += 1;
  }
  return {
    pairs: taskPairs.length,
    bothPass,
    bothFail,
    onOnly,
    offOnly,
    concordant: bothPass + bothFail,
    discordant: onOnly + offOnly,
  };
}

function mcnemarExact(onOnly: number, offOnly: number): number {
  if (!Number.isInteger(onOnly) || onOnly < 0) {
    throw new TypeError('onOnly must be a nonnegative integer');
  }
  if (!Number.isInteger(offOnly) || offOnly < 0) {
    throw new TypeError('offOnly must be a nonnegative integer');
  }
  const discordantPairs = onOnly + offOnly;
  if (discordantPairs === 0) return 1;
  const smallerOutcome = Math.min(onOnly, offOnly);
  let probabilityAtOutcome = 0.5 ** discordantPairs;
  let lowerTailProbability = probabilityAtOutcome;
  for (let outcome = 1; outcome <= smallerOutcome; outcome += 1) {
    probabilityAtOutcome *= (discordantPairs - outcome + 1) / outcome;
    lowerTailProbability += probabilityAtOutcome;
  }
  return Math.min(1, lowerTailProbability * 2);
}

function summariseAblation(taskPairs: TaskPair[] | null | undefined) {
  const tallies = pairOutcomes(taskPairs);
  const pValue = mcnemarExact(tallies.onOnly, tallies.offOnly);
  let verdict = 'no-signal';
  if (tallies.pairs === 0 || tallies.discordant === 0) verdict = 'insufficient';
  if (pValue < SIGNIFICANCE_THRESHOLD && tallies.onOnly > tallies.offOnly) verdict = 'on-better';
  if (pValue < SIGNIFICANCE_THRESHOLD && tallies.offOnly > tallies.onOnly) verdict = 'off-better';
  return {
    pairs: tallies.pairs,
    bothPass: tallies.bothPass,
    bothFail: tallies.bothFail,
    onOnly: tallies.onOnly,
    offOnly: tallies.offOnly,
    pValue,
    verdict,
  };
}

export {
  armOutcome,
  classifyObservedPrompts,
  emptyPromptCounts,
  mcnemarExact,
  pairArmOrder,
  pairOutcomes,
  promptCount,
  summariseAblation,
  turnBudget,
};
