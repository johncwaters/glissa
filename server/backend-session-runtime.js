'use strict';

const { HookRouter } = require('../detection/hook-source');
const { sweepOrphans } = require('../detection/settings-injector');
const { createRtkInstallWiring } = require('./rtk-install-wiring');
const { getRtkPath } = require('./rtk-resolver');
const { createSessionFactory } = require('./session-factory');
const { hooksForProject } = require('../session/core/user-hooks-core');
const { buildSettingsPayload } = require('./settings-payload');

/** @type {(options: { configStore: object, rtkInstallStatus?: Record<string, unknown>|null }) => Record<string, unknown>} */
const buildRuntimeSettingsPayload = /** @type {(options: { configStore: object, rtkInstallStatus?: Record<string, unknown>|null }) => Record<string, unknown>} */ (buildSettingsPayload);

/**
 * @typedef {object} BackendSessionRuntimeDependencies
 * @property {import('http').Server} httpServer
 * @property {{ hooks?: unknown, rtk?: boolean } & object} config
 * @property {any} configStore
 * @property {() => any} getGitWorkspace
 * @property {() => import('./backend-websockets').ControlBroadcast|null} getBroadcastControl
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
      const broadcast = dependencies.getBroadcastControl();
      if (!broadcast) return;
      broadcast({
        type: 'settings-updated',
        settings: buildRuntimeSettingsPayload({ configStore: dependencies.configStore, rtkInstallStatus: status }),
      });
    },
  });
  const makeSession = createSessionFactory({
    configStore: dependencies.configStore,
    hookRouter,
    getHookPort,
    getGitWorkspace: dependencies.getGitWorkspace,
    rtkPathForConfig,
    // The live config object, so a hook saved after boot is what the next spawn reads.
    getUserHooks: (projectId) => hooksForProject(dependencies.config.hooks, projectId),
  });

  return { getHookPort, hookRouter, makeSession, rtkInstall };
}

module.exports = { createBackendSessionRuntime };
