import { DEFAULT_INTERVAL_MS, DEFAULT_STALE_DAYS, createBranchGcPoller } from './branch-gc-poller.ts';
import { DEFAULT_BRANCH_GC_PREFIXES } from './core/branch-gc-core.ts';
import type { BranchGcGitWorkspace, BranchGcPoller } from './branch-gc-poller.ts';
import { createLaneRunner } from './lane-runner.ts';
import type { LaneRunnerGate, LaneStatusRecord } from './lane-runner.ts';
import { emptyLaneStatus } from './lane-status.ts';
import type { BranchGcFileSettings } from '../shared/contracts/index.ts';

interface BranchGcWiringConfig {
  integrationBranch?: string | null;
  projects?: { id?: string; path?: string }[];
  branchGc?: BranchGcFileSettings | null;
}

interface BranchGcWiringOptions {
  config: BranchGcWiringConfig;
  gitWorkspace: BranchGcGitWorkspace;
  liveSessionIds: () => Set<string>;
  broadcast?: (message: LaneStatusRecord) => void;
  log?: Console;
  decisionTrace?: (entry: Record<string, unknown>) => void;
  createPoller?: typeof createBranchGcPoller;
}

interface BranchGcWiring {
  start(): void;
  stop(): Promise<void>;
  restartIfConfigChanged(): void;
  getStatus(): LaneStatusRecord;
}

function branchGcShouldStart(config: BranchGcWiringConfig): LaneRunnerGate {
  if (config.branchGc?.enabled === false) return { start: false };
  return { start: true };
}

function branchGcCfgKey(config: BranchGcWiringConfig): string {
  return JSON.stringify(config.branchGc ?? null);
}

function createBranchGcWiring({
  config,
  gitWorkspace,
  liveSessionIds,
  broadcast = () => {},
  log = console,
  decisionTrace = (entry: Record<string, unknown>) => log.info(`[branch-gc] decision ${JSON.stringify(entry)}`),
  createPoller = createBranchGcPoller,
}: BranchGcWiringOptions): BranchGcWiring {
  const runner = createLaneRunner<BranchGcPoller>({
    tag: 'branch-gc',
    gate: () => branchGcShouldStart(config),
    cfgKey: () => branchGcCfgKey(config),
    emptyStatus: () => emptyLaneStatus('branch-gc-status', branchGcShouldStart(config)),
    broadcast,
    createPoller: ({ onTickComplete }) => createPoller({
      gitWorkspace,
      getConfig: () => config,
      liveSessionIds,
      staleDays: config.branchGc?.staleDays ?? DEFAULT_STALE_DAYS,
      prefixes: config.branchGc?.prefixes ?? DEFAULT_BRANCH_GC_PREFIXES,
      dryRun: config.branchGc?.dryRun ?? false,
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

export { branchGcCfgKey, branchGcShouldStart, createBranchGcWiring };
export type { BranchGcWiring, BranchGcWiringConfig, BranchGcWiringOptions };
