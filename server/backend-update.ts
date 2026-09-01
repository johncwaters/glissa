import type { ControlBroadcast } from './backend-websockets.ts';
import type { decideUpdateStatus } from './core/update-core.ts';
import { shortSha } from './core/update-core.ts';
import { checkForUpdate as defaultCheckForUpdate } from './update-check.js';

const UPDATE_RECHECK_MS = 24 * 60 * 60 * 1000;

type UpdateStatus = ReturnType<typeof decideUpdateStatus>;
type CheckForUpdate = (options: { currentVersion: string; abortController: AbortController }) => Promise<UpdateStatus | null>;

interface BackendUpdateDependencies {
  config: { checkForUpdates?: boolean };
  isLocalConfig: boolean;
  currentVersion: string;
  checkForUpdate: CheckForUpdate | undefined;
  getControlClientCount: () => number;
  broadcastControl: ControlBroadcast;
  logger: Pick<Console, 'log'>;
}

interface BackendUpdateCheck {
  getStatus(): UpdateStatus | null;
  start(): void;
  stop(): void;
}

function createBackendUpdateCheck(dependencies: BackendUpdateDependencies): BackendUpdateCheck {
  let updateStatus: UpdateStatus | null = null;
  let updateAbort: AbortController | null = null;
  let updateRecheckInterval: NodeJS.Timeout | null = null;

  function getStatus(): UpdateStatus | null {
    return updateStatus;
  }

  function surfaceUpdate(updateResult: UpdateStatus | null): void {
    if (!updateResult || !updateResult.updateAvailable) return;
    const alreadySurfaced = Boolean(updateStatus)
      && (updateStatus?.latest || updateStatus?.latestSha) === (updateResult.latest || updateResult.latestSha);
    updateStatus = updateResult;
    if (alreadySurfaced) return;
    const currentRelease = updateResult.current || 'unknown';
    const latestRelease = updateResult.latest || shortSha(updateResult.latestSha) || 'unknown';
    dependencies.logger.log(
      `[update] A newer glissa is available: ${currentRelease} -> ${latestRelease}. Update: ${updateResult.command}`,
    );
    dependencies.broadcastControl({ type: 'update-available', ...updateResult });
  }

  function runAndSurfaceUpdate(): Promise<void> {
    updateAbort = new AbortController();
    const runUpdateCheck = dependencies.checkForUpdate || defaultCheckForUpdate;
    return runUpdateCheck({
      currentVersion: dependencies.currentVersion,
      abortController: updateAbort,
    }).then(surfaceUpdate).catch(() => {});
  }

  function start(): void {
    if (dependencies.config.checkForUpdates === false) return;
    if (dependencies.isLocalConfig) return;
    void runAndSurfaceUpdate();
    updateRecheckInterval = setInterval(() => {
      if (dependencies.getControlClientCount() === 0) return;
      void runAndSurfaceUpdate();
    }, UPDATE_RECHECK_MS);
    updateRecheckInterval.unref();
  }

  function stop(): void {
    if (updateAbort) {
      try {
        updateAbort.abort();
      } catch {}
    }
    if (updateRecheckInterval) clearInterval(updateRecheckInterval);
  }

  return { getStatus, start, stop };
}

export { createBackendUpdateCheck };
export type { BackendUpdateCheck, BackendUpdateDependencies, CheckForUpdate, UpdateStatus };
