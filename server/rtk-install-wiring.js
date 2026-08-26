'use strict';

const os = require('node:os');

const { decideRtkInstall } = require('./core/rtk-install-core');
const { installRtk } = require('./rtk-installer');
const { getRtkPath } = require('./rtk-resolver');

// One-shot lane, not a poller: the only triggers are boot and a settings save, so there is no timer to
// own. getRtkPath memoizes successes only, so a fresh install is picked up by the next call with no bust.
/**
 * @param {{ config?: { rtk?: boolean }, homeDir?: string, platform?: NodeJS.Platform,
 *   arch?: NodeJS.Architecture, log?: Console | null, now?: () => number,
 *   resolveRtk?: () => string | null, install?: typeof installRtk,
 *   onStatusChange?: (status: Record<string, unknown>) => void }} [options]
 */
function createRtkInstallWiring({
  config,
  homeDir = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  log = console,
  now = () => Date.now(),
  resolveRtk = getRtkPath,
  install = installRtk,
  onStatusChange = () => {},
} = {}) {
  let status = { status: 'idle' };
  let inFlight = false;
  let lastFailureAt = null;

  const getStatus = () => ({ ...status });

  function setStatus(next) {
    status = next;
    onStatusChange(getStatus());
  }

  async function maybeInstall() {
    const rtkEnabled = config.rtk === true;
    const decision = decideRtkInstall({
      rtkEnabled,
      resolvedPath: rtkEnabled ? resolveRtk() : null,
      platform,
      arch,
      inFlight,
      lastFailureAt,
      nowMs: now(),
    });
    if (decision.action === 'skip') return decision;

    inFlight = true;
    setStatus({ status: 'installing' });
    log?.log?.(`[rtk] no rtk binary resolved and config.rtk is on: installing ${decision.asset.version}`);
    try {
      const result = await install({ homeDir, platform, arch, log });
      if (result.ok) {
        lastFailureAt = null;
        setStatus({ status: 'installed', path: result.path });
        return { ...decision, result };
      }
      lastFailureAt = now();
      log?.warn?.(`[rtk] install failed: ${result.reason}`);
      setStatus({ status: 'failed', reason: result.reason });
      return { ...decision, result };
    } finally {
      inFlight = false;
    }
  }

  return { maybeInstall, getStatus };
}

module.exports = { createRtkInstallWiring };
