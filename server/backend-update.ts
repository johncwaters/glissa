import type { UpdateStatus } from '../shared/contracts/control-messages.ts';
import type { UpdateChannel, UpdateJournal, UpdateJournalSummary } from '../shared/contracts/update-journal.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import { decideUpdateStatus, normalizeUpdateChannel, shortSha } from './core/update-core.ts';
import { checkForUpdate as defaultCheckForUpdate } from './update-check.ts';
import type { FetchOrigin, UpdateCheckStatus } from './update-check.ts';

const UPDATE_RECHECK_MS = 24 * 60 * 60 * 1000;

type CheckForUpdate = (options: {
  currentVersion: string;
  updateChannel: UpdateChannel;
  abortController: AbortController;
  fetchOrigin?: FetchOrigin;
  ttlMs?: number;
}) => Promise<UpdateCheckStatus | null>;

interface BackendUpdateDependencies {
  config: { checkForUpdates?: boolean; updateChannel?: UpdateChannel };
  isLocalConfig: boolean;
  currentVersion: string;
  checkForUpdate: CheckForUpdate | undefined;
  fetchOrigin?: FetchOrigin;
  getUpdateJournal?: () => UpdateJournal | null;
  getControlClientCount: () => number;
  broadcastControl: ControlBroadcast;
  logger: Pick<Console, 'log'>;
  now?: () => number;
}

interface BackendUpdateCheck {
  applySettings(): void;
  checkNow(): Promise<UpdateStatus>;
  getStatus(): UpdateStatus | null;
  start(): void;
  stop(): void;
}

function journalSummary(journal: UpdateJournal | null | undefined): UpdateJournalSummary | null {
  if (!journal) return null;
  return {
    state: journal.state,
    activeStep: journal.activeStep,
    reason: journal.reason,
    startedAt: journal.startedAt,
    finishedAt: journal.finishedAt,
  };
}

function createBackendUpdateCheck(dependencies: BackendUpdateDependencies): BackendUpdateCheck {
  let updateStatus: UpdateStatus | null = null;
  let updateAbort: AbortController | null = null;
  let updateRecheckInterval: NodeJS.Timeout | null = null;
  let inFlight: Promise<UpdateStatus> | null = null;
  let lastChannel = normalizeUpdateChannel(dependencies.config.updateChannel);
  let lastSurfacedIdentity: string | null = null;
  let pendingChannelRefresh = false;
  let stopped = false;
  const now = dependencies.now || (() => Date.now());

  function getStatus(): UpdateStatus | null {
    if (!updateStatus) return null;
    return {
      ...updateStatus,
      journalSummary: journalSummary(dependencies.getUpdateJournal?.()),
    };
  }

  function failedStatus(channel: UpdateChannel, lastCheckAt: number): UpdateCheckStatus {
    return {
      ...decideUpdateStatus({
        currentVersion: dependencies.currentVersion,
        channel,
        reason: 'update-check-failed',
      }),
      installedBranch: null,
      upstream: null,
      isTreeClean: null,
      lastCheckAt,
    };
  }

  function recordStatus(updateResult: UpdateCheckStatus | null, checkedAt: number, channel: UpdateChannel): UpdateStatus {
    const recorded = updateResult || failedStatus(channel, checkedAt);
    const status: UpdateStatus = {
      ...recorded,
      lastCheckAt: checkedAt,
      journalSummary: journalSummary(dependencies.getUpdateJournal?.()),
    };
    updateStatus = status;
    dependencies.broadcastControl({ type: 'update-status', ...status });
    return status;
  }

  function surfaceAvailableUpdate(status: UpdateStatus): void {
    if (!status.updateAvailable) return;
    const identity = status.latest || status.latestSha;
    if (identity && identity === lastSurfacedIdentity) return;
    lastSurfacedIdentity = identity;
    const currentRelease = status.current || shortSha(status.currentSha) || 'unknown';
    const latestRelease = status.latest || shortSha(status.latestSha) || 'unknown';
    dependencies.logger.log(
      `[update] A newer glissa is available: ${currentRelease} -> ${latestRelease}. Update: ${status.command}`,
    );
  }

  function runCheck(ttlMs?: number): Promise<UpdateStatus> {
    if (inFlight) return inFlight;
    const channel = normalizeUpdateChannel(dependencies.config.updateChannel);
    const checkedAt = now();
    updateAbort = new AbortController();
    const runUpdateCheck = dependencies.checkForUpdate || defaultCheckForUpdate;
    const run = runUpdateCheck({
      currentVersion: dependencies.currentVersion,
      updateChannel: channel,
      abortController: updateAbort,
      ...(dependencies.fetchOrigin ? { fetchOrigin: dependencies.fetchOrigin } : {}),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    })
      .catch(() => null)
      .then((updateResult) => {
        if (stopped || channel !== normalizeUpdateChannel(dependencies.config.updateChannel)) {
          return {
            ...failedStatus(channel, checkedAt),
            journalSummary: journalSummary(dependencies.getUpdateJournal?.()),
          };
        }
        const status = recordStatus(updateResult, checkedAt, channel);
        surfaceAvailableUpdate(status);
        return status;
      })
      .finally(() => {
        inFlight = null;
        updateAbort = null;
        if (!pendingChannelRefresh) return;
        pendingChannelRefresh = false;
        if (stopped) return;
        void runCheck(0);
      });
    inFlight = run;
    return run;
  }

  function checkNow(): Promise<UpdateStatus> {
    return runCheck(0);
  }

  function applySettings(): void {
    if (stopped) return;
    const channel = normalizeUpdateChannel(dependencies.config.updateChannel);
    if (channel === lastChannel) return;
    lastChannel = channel;
    updateStatus = null;
    lastSurfacedIdentity = null;
    if (inFlight) {
      pendingChannelRefresh = true;
      updateAbort?.abort();
      return;
    }
    void checkNow();
  }

  function start(): void {
    if (dependencies.config.checkForUpdates === false) return;
    if (dependencies.isLocalConfig) return;
    void runCheck();
    updateRecheckInterval = setInterval(() => {
      if (dependencies.getControlClientCount() === 0) return;
      void runCheck();
    }, UPDATE_RECHECK_MS);
    updateRecheckInterval.unref();
  }

  function stop(): void {
    stopped = true;
    pendingChannelRefresh = false;
    updateAbort?.abort();
    if (updateRecheckInterval) clearInterval(updateRecheckInterval);
    updateRecheckInterval = null;
  }

  return { applySettings, checkNow, getStatus, start, stop };
}

export { createBackendUpdateCheck };
export type { BackendUpdateCheck, BackendUpdateDependencies, CheckForUpdate, UpdateStatus };
