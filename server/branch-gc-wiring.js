'use strict';

const { createBranchGcPoller, DEFAULT_INTERVAL_MS, DEFAULT_STALE_DAYS } = require('./branch-gc-poller');
const { createLaneRunner } = require('./lane-runner');
const { emptyLaneStatus } = require('./lane-status');

function branchGcShouldStart(config) {
  if (config.branchGc?.enabled === false) return { start: false, reason: null };
  return { start: true, reason: null };
}

function branchGcCfgKey(config) {
  return JSON.stringify(config.branchGc ?? null);
}

function createBranchGcWiring({
  config,
  gitWorkspace,
  broadcast = () => {},
  log = console,
  decisionTrace = (entry) => log.info(`[branch-gc] decision ${JSON.stringify(entry)}`),
  createPoller = createBranchGcPoller,
}) {
  const runner = createLaneRunner({
    tag: 'branch-gc',
    gate: () => branchGcShouldStart(config),
    cfgKey: () => branchGcCfgKey(config),
    emptyStatus: () => emptyLaneStatus('branch-gc-status', branchGcShouldStart(config)),
    broadcast,
    createPoller: ({ onTickComplete }) => createPoller({
      gitWorkspace,
      getConfig: () => config,
      staleDays: config.branchGc?.staleDays ?? DEFAULT_STALE_DAYS,
      intervalMs: config.branchGc?.intervalMs ?? DEFAULT_INTERVAL_MS,
      log,
      decisionTrace,
      onTickComplete,
    }),
  });

  return {
    start: runner.startPoller,
    stop: runner.stopPoller,
    restartIfConfigChanged: runner.restartIfConfigChanged,
    getStatus: runner.getStatus,
  };
}

module.exports = { branchGcCfgKey, branchGcShouldStart, createBranchGcWiring };
