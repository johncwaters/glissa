'use strict';

const crypto = require('node:crypto');
const { hostOfOrigin } = require('./core/origin-policy');
const { decideBindHost, normalizeRemoteConfig, validateRemoteConfig } = require('./core/remote-config');
const { createPairingsStore, createSeenStore, defaultPairingsPath, defaultSeenPath } = require('./pairings-store');
const { createRemoteAuth } = require('./remote-auth');

/**
 * @typedef {object} BackendTrustDependencies
 * @property {number} localPort
 * @property {object|null} remoteConfig
 * @property {string} configPath
 * @property {NodeJS.ProcessEnv} env
 */

function bootError(message) {
  const error = new Error(message);
  error.glissaBoot = true;
  return error;
}

/** @param {BackendTrustDependencies} dependencies */
function createBackendTrust(dependencies) {
  const remote = normalizeRemoteConfig(dependencies.remoteConfig);
  const remoteCheck = validateRemoteConfig(remote, dependencies.localPort);
  if (!remoteCheck.ok) throw bootError(`[remote] invalid configuration: ${remoteCheck.error}`);
  const bindDecision = decideBindHost({
    envHost: dependencies.env.GLISSA_HOST,
    insecureBind: dependencies.env.GLISSA_INSECURE_BIND === '1',
  });
  const remoteListenerPort = remote.enabled ? remote.port : null;
  const pageToken = crypto.randomBytes(32).toString('hex');
  const pageTokenBuffer = Buffer.from(pageToken, 'utf8');
  const allowedHosts = (remote.enabled
    ? [remote.publicHost, ...remote.allowedOrigins.map(hostOfOrigin)]
    : []
  ).filter((host) => typeof host === 'string' && host !== '');
  const remoteAuth = remote.enabled
    ? createRemoteAuth({
      remote,
      pairingsStore: createPairingsStore({ filePath: defaultPairingsPath(dependencies.configPath) }),
      seenStore: createSeenStore({ filePath: defaultSeenPath(dependencies.configPath) }),
    })
    : null;

  function tokenMatches(presented) {
    if (typeof presented !== 'string' || presented.length !== pageToken.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(presented, 'utf8'), pageTokenBuffer);
    } catch {
      return false;
    }
  }

  function listenerPortsFor(socket) {
    const listenerPort = socket && typeof socket.localPort === 'number' ? socket.localPort : null;
    return listenerPort == null ? [] : [listenerPort];
  }

  return {
    remote,
    bindDecision,
    remoteListenerPort,
    pageToken,
    allowedHosts,
    remoteAuth,
    tokenMatches,
    listenerPortsFor,
  };
}

module.exports = { createBackendTrust };
