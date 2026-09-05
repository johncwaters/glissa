import type { UpdateApplyRefusal, UpdateStatus } from '../shared/contracts/control-messages.ts';
import type { UpdateChannel, UpdateJournal, UpdateJournalSummary } from '../shared/contracts/update-journal.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import { decideFastForward, decidePreflight } from './core/update-apply-core.ts';
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
  platform?: NodeJS.Platform;
  checkForUpdate: CheckForUpdate | undefined;
  fetchOrigin?: FetchOrigin;
  getUpdateJournal?: () => UpdateJournal | null;
  isRestartRequested?: () => boolean;
  getControlClientCount: () => number;
  broadcastControl: ControlBroadcast;
  logger: Pick<Console, 'log'>;
  now?: () => number;
}

interface BackendUpdateCheck {
  applySettings(): void;
  checkNow(): Promise<UpdateStatus>;
  getStatus(): UpdateStatus | null;
  refreshApplyAvailability(): void;
  start(): void;
  stop(): void;
}

type RecordedUpdateStatus = Omit<UpdateStatus, 'journalSummary' | 'applyRefusal'>;

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
  let recordedStatus: RecordedUpdateStatus | null = null;
  let lastLaneSignature: string | null = null;
  let updateAbort: AbortController | null = null;
  let updateRecheckInterval: NodeJS.Timeout | null = null;
  let inFlight: Promise<UpdateStatus> | null = null;
  let lastChannel = normalizeUpdateChannel(dependencies.config.updateChannel);
  let lastSurfacedIdentity: string | null = null;
  let pendingChannelRefresh = false;
  let stopped = false;
  const now = dependencies.now || (() => Date.now());
  const platform: string = dependencies.platform || process.platform;

  function decideApplyRefusal(
    recorded: RecordedUpdateStatus,
    journal: UpdateJournal | null | undefined,
  ): UpdateApplyRefusal | null {
    const decision = decidePreflight({
      flavor: recorded.flavor,
      platform,
      statusChannel: recorded.channel,
      configuredChannel: normalizeUpdateChannel(dependencies.config.updateChannel),
      updateAvailable: recorded.updateAvailable,
      isTreeClean: recorded.isTreeClean === true,
      branch: recorded.installedBranch,
      upstream: recorded.upstream,
      statusBranch: recorded.installedBranch,
      statusUpstream: recorded.upstream,
      headSha: recorded.currentSha,
      targetSha: recorded.latestSha,
      journalState: journal?.state || 'idle',
      restartRequested: dependencies.isRestartRequested?.() === true,
    });
    if (!decision.ok) return { reason: decision.reason, message: decision.message };
    const fastForward = decideFastForward({ canFastForward: recorded.reason !== 'branch-diverged' });
    if (fastForward.ok) return null;
    return { reason: fastForward.reason, message: fastForward.message };
  }

  function projectStatus(recorded: RecordedUpdateStatus): UpdateStatus {
    const journal = dependencies.getUpdateJournal?.();
    return {
      ...recorded,
      journalSummary: journalSummary(journal),
      applyRefusal: decideApplyRefusal(recorded, journal),
    };
  }

  function laneSignature(status: UpdateStatus): string {
    return `${status.journalSummary?.state || 'none'}|${status.applyRefusal?.reason || 'none'}`;
  }

  function broadcastStatus(status: UpdateStatus): void {
    lastLaneSignature = laneSignature(status);
    dependencies.broadcastControl({ type: 'update-status', ...status });
  }

  function getStatus(): UpdateStatus | null {
    if (!recordedStatus) return null;
    return projectStatus(recordedStatus);
  }

  function refreshApplyAvailability(): void {
    if (stopped || !recordedStatus) return;
    const status = projectStatus(recordedStatus);
    if (laneSignature(status) === lastLaneSignature) return;
    broadcastStatus(status);
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
    recordedStatus = { ...(updateResult || failedStatus(channel, checkedAt)), platform, lastCheckAt: checkedAt };
    const status = projectStatus(recordedStatus);
    broadcastStatus(status);
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
          return projectStatus({ ...failedStatus(channel, checkedAt), platform });
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
    recordedStatus = null;
    lastLaneSignature = null;
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

  return { applySettings, checkNow, getStatus, refreshApplyAvailability, start, stop };
}

export { createBackendUpdateCheck };
export type { BackendUpdateCheck, BackendUpdateDependencies, CheckForUpdate, UpdateStatus };
