import { getRtkPath } from './rtk-resolver.ts';

interface SettingsPayloadOptions {
  configStore: { getSettings: () => Record<string, unknown> };
  rtkInstallStatus?: Record<string, unknown> | null;
  resolveRtk?: () => string | null;
}

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
