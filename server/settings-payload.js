'use strict';

const { getRtkPath } = require('../session/core/rtk-command');

// One shape, two publishers: control-handlers answers get-settings/update-settings with it, and the
// backend rebroadcasts it when an rtk install finishes long after the save that started it.
function buildSettingsPayload({ configStore, rtkInstallStatus = null, resolveRtk = getRtkPath }) {
  return {
    ...configStore.getSettings(),
    rtkAvailable: !!resolveRtk(),
    rtkInstall: rtkInstallStatus || { status: 'idle' },
  };
}

module.exports = { buildSettingsPayload };
