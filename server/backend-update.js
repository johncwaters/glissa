'use strict';

const { checkForUpdate: defaultCheckForUpdate } = require('./update-check');
const { shortSha } = require('./core/update-core');

const UPDATE_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} BackendUpdateDependencies
 * @property {{ checkForUpdates?: boolean }} config
 * @property {boolean} isLocalConfig
 * @property {string} currentVersion
 * @property {((options: { currentVersion: string, abortController: AbortController }) => Promise<any>)|undefined} checkForUpdate
 * @property {() => number} getControlClientCount
 * @property {(message: object) => void} broadcastControl
 * @property {Pick<Console, 'log'>} logger
 */

/** @param {BackendUpdateDependencies} dependencies */
function createBackendUpdateCheck(dependencies) {
  let updateStatus = null;
  let updateAbort = null;
  let updateRecheckInterval = null;

  function getStatus() {
    return updateStatus;
  }

  function surfaceUpdate(updateResult) {
    if (!updateResult || !updateResult.updateAvailable) return;
    const alreadySurfaced = Boolean(updateStatus)
      && (updateStatus.latest || updateStatus.latestSha) === (updateResult.latest || updateResult.latestSha);
    updateStatus = updateResult;
    if (alreadySurfaced) return;
    const currentRelease = updateResult.current || 'unknown';
    const latestRelease = updateResult.latest || shortSha(updateResult.latestSha) || 'unknown';
    dependencies.logger.log(
      `[update] A newer glissa is available: ${currentRelease} -> ${latestRelease}. Update: ${updateResult.command}`,
    );
    dependencies.broadcastControl({ type: 'update-available', ...updateResult });
  }

  function runAndSurfaceUpdate() {
    updateAbort = new AbortController();
    const runUpdateCheck = dependencies.checkForUpdate || defaultCheckForUpdate;
    return runUpdateCheck({
      currentVersion: dependencies.currentVersion,
      abortController: updateAbort,
    }).then(surfaceUpdate).catch(() => {});
  }

  function start() {
    if (dependencies.config.checkForUpdates === false) return;
    if (dependencies.isLocalConfig) return;
    void runAndSurfaceUpdate();
    updateRecheckInterval = setInterval(() => {
      if (dependencies.getControlClientCount() === 0) return;
      void runAndSurfaceUpdate();
    }, UPDATE_RECHECK_MS);
    updateRecheckInterval.unref();
  }

  function stop() {
    if (updateAbort) {
      try {
        updateAbort.abort();
      } catch {}
    }
    if (updateRecheckInterval) clearInterval(updateRecheckInterval);
  }

  return { getStatus, start, stop };
}

module.exports = { createBackendUpdateCheck };
