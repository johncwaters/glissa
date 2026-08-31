'use strict';

const { classifyPrompt } = require('../../server/core/mill-metrics-core.ts');

const OUTCOMES = new Set(['pass', 'fail']);
const SIGNIFICANCE_THRESHOLD = 0.05;

function armOutcome(executionError, checkPassed) {
  if (executionError) return 'invalid';
  if (checkPassed) return 'pass';
  return 'fail';
}

// The ON pack mandates a Read turn before the task, so the treatment gets that turn back.
function turnBudget(armName, maxTurns) {
  if (armName === 'on') return maxTurns + 1;
  return maxTurns;
}

function pairArmOrder(taskIndex, seed) {
  const isOnFirst = (taskIndex + seed - 1) % 2 === 0;
  if (isOnFirst) return ['on', 'off'];
  return ['off', 'on'];
}

function emptyPromptCounts() {
  return { interruption: 0, answer: 0, followup: 0, ambiguous: 0 };
}

function classifyObservedPrompts(promptPayloads) {
  const prompts = emptyPromptCounts();
  for (const payload of promptPayloads) {
    const timestamp = Number.isFinite(payload?.ts) ? payload.ts : Date.now();
    const promptClass = classifyPrompt({
      state: typeof payload?.state === 'string' ? payload.state : '',
      stateSince: Number.isFinite(payload?.stateSince) ? payload.stateSince : timestamp,
      ts: timestamp,
    });
    prompts[promptClass] += 1;
  }
  return prompts;
}

function promptCount(prompts) {
  return Object.values(prompts).reduce((total, count) => total + count, 0);
}

function pairOutcomes(taskPairs) {
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

function mcnemarExact(onOnly, offOnly) {
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

function summariseAblation(taskPairs) {
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

module.exports = {
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
