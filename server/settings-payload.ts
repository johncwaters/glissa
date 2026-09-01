import { getRtkPath } from './rtk-resolver.ts';

interface SettingsPayloadOptions {
  configStore: { getSettings: () => Record<string, unknown> };
  rtkInstallStatus?: Record<string, unknown> | null;
  resolveRtk?: () => string | null;
}

// One shape, two publishers: control-handlers answers get-settings/update-settings with it, and the
// backend rebroadcasts it when an rtk install finishes long after the save that started it.
function buildSettingsPayload({
  configStore, rtkInstallStatus = null, resolveRtk = getRtkPath,
}: SettingsPayloadOptions): Record<string, unknown> {
  return {
    ...configStore.getSettings(),
    rtkAvailable: !!resolveRtk(),
    rtkInstall: rtkInstallStatus || { status: 'idle' },
  };
}

export { buildSettingsPayload };
export type { SettingsPayloadOptions };
