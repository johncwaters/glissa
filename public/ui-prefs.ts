import { getJSON, setJSON } from './local-store.ts';

const STORAGE_KEY = 'glissa-ui-prefs';
const SIDEBAR_WIDTH_KEY = 'glissa:sidebar-width';

export interface UiPrefs {
  soundEnabled: boolean;
  soundId: string;
  themeId: string;
  notificationsEnabled: boolean;
  activeView: string;
  lastFocusedSessionId: string | null;
  railWidth: number | null;
  keptProjects: string[];
  dismissedUpdate: string | null;
  radarAttentionAck: string;
  prsAttentionAck: string;
  usageAttentionAck: string;
  millAttentionAck: string;
}

const asBoolean = (fallback: boolean) => (value: unknown): boolean => (typeof value === 'boolean' ? value : fallback);
const asString = (fallback: string) => (value: unknown): string => (typeof value === 'string' ? value : fallback);
const asNullableString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const asNullableNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry !== ''))] : [];

const PREFS: { [Key in keyof UiPrefs]: (value: unknown) => UiPrefs[Key] } = {
  soundEnabled: asBoolean(true),
  soundId: asString('coins'),
  themeId: asString('phyrexian'),
  notificationsEnabled: asBoolean(true),
  activeView: asString('focus'),
  lastFocusedSessionId: asNullableString,
  railWidth: asNullableNumber,
  keptProjects: asStringList,
  dismissedUpdate: asNullableString,
  radarAttentionAck: asString(''),
  prsAttentionAck: asString(''),
  usageAttentionAck: asString(''),
  millAttentionAck: asString(''),
};

function normalizeInto<Key extends keyof UiPrefs>(prefs: Partial<UiPrefs>, key: Key, raw: unknown) {
  prefs[key] = PREFS[key](raw);
}

function load(): UiPrefs {
  const stored = getJSON<Record<string, unknown>>(STORAGE_KEY, {});
  const prefs: Partial<UiPrefs> = {};
  for (const key of Object.keys(PREFS) as (keyof UiPrefs)[]) normalizeInto(prefs, key, stored?.[key]);
  return prefs as UiPrefs;
}

function read<Key extends keyof UiPrefs>(key: Key): UiPrefs[Key] {
  return load()[key];
}

function write<Key extends keyof UiPrefs>(key: Key, value: unknown) {
  const prefs = load();
  normalizeInto(prefs, key, value);
  setJSON(STORAGE_KEY, prefs);
}

export const isSoundEnabled = () => read('soundEnabled');
export const setSoundEnabled = (enabled: boolean) => write('soundEnabled', enabled);

export const getSoundId = () => read('soundId');
export const setSoundId = (id: string) => write('soundId', id);

export const isNotificationsEnabled = () => read('notificationsEnabled');
export const setNotificationsEnabled = (enabled: boolean) => write('notificationsEnabled', enabled);

export const getThemeId = () => read('themeId');
export const setThemeId = (id: string) => write('themeId', id);

export const getActiveView = () => read('activeView');
export const setActiveView = (view: string) => write('activeView', view);

export const getRailWidth = () => read('railWidth');
export const setRailWidth = (px: number | null) => write('railWidth', px);

export const getKeptProjects = () => read('keptProjects');
export const setKeptProjects = (paths: string[]) => write('keptProjects', paths);

export const getDismissedUpdate = () => read('dismissedUpdate');
export const setDismissedUpdate = (key: string | null) => write('dismissedUpdate', key);

export const getRadarAttentionAck = () => read('radarAttentionAck');
export const setRadarAttentionAck = (signature: string) => write('radarAttentionAck', signature);

export const getPrsAttentionAck = () => read('prsAttentionAck');
export const setPrsAttentionAck = (signature: string) => write('prsAttentionAck', signature);

export const getUsageAttentionAck = () => read('usageAttentionAck');
export const setUsageAttentionAck = (signature: string) => write('usageAttentionAck', signature);

export const getMillAttentionAck = () => read('millAttentionAck');
export const setMillAttentionAck = (signature: string) => write('millAttentionAck', signature);

export const getLastFocusedSessionId = () => read('lastFocusedSessionId');
export const setLastFocusedSessionId = (id: string | null) => write('lastFocusedSessionId', id);

export const getSidebarWidth = () => asNullableNumber(getJSON(SIDEBAR_WIDTH_KEY, null));
export const setSidebarWidth = (px: number | null) => setJSON(SIDEBAR_WIDTH_KEY, asNullableNumber(px));
