'use strict';

const { HookRouter } = require('../detection/hook-source');
const { sweepOrphans } = require('../detection/settings-injector');
const { createRtkInstallWiring } = require('./rtk-install-wiring');
const { getRtkPath } = require('./rtk-resolver');
const { createSessionFactory } = require('./session-factory');
const { buildSettingsPayload } = require('./settings-payload');

/**
 * @typedef {object} BackendSessionRuntimeDependencies
 * @property {import('http').Server} httpServer
 * @property {object} config
 * @property {any} configStore
 * @property {() => any} getGitWorkspace
 * @property {() => ((message: object) => void)} getBroadcastControl
 * @property {Pick<Console, 'warn'>} logger
 */

/** @param {BackendSessionRuntimeDependencies} dependencies */
function createBackendSessionRuntime(dependencies) {
  const hookRouter = new HookRouter();
  const getHookPort = () => {
    const address = dependencies.httpServer?.address();
    if (!address || typeof address !== 'object' || !address.port) return null;
    return address.port;
  };
  try {
    sweepOrphans();
  } catch {}

  let hasWarnedMissingRtk = false;
  function rtkPathForConfig(config) {
    if (!config.rtk) return null;
    const rtkPath = getRtkPath();
    if (rtkPath) return rtkPath;
    if (hasWarnedMissingRtk) return null;
    hasWarnedMissingRtk = true;
    dependencies.logger.warn(
      '[rtk] config.rtk is true, but no rtk binary was found. Sessions will spawn without rtk hooks.',
    );
    return null;
  }

  const rtkInstall = createRtkInstallWiring({
    config: dependencies.config,
    onStatusChange: (status) => {
      dependencies.getBroadcastControl()({
        type: 'settings-updated',
        settings: buildSettingsPayload({ configStore: dependencies.configStore, rtkInstallStatus: status }),
      });
    },
  });
  const makeSession = createSessionFactory({
    configStore: dependencies.configStore,
    hookRouter,
    getHookPort,
    getGitWorkspace: dependencies.getGitWorkspace,
    rtkPathForConfig,
  });

  return { getHookPort, hookRouter, makeSession, rtkInstall };
}

module.exports = { createBackendSessionRuntime };
