// ── UI preferences ───────────────────────────────────────────
// THE home for browser-side UI state, so no surface reaches for localStorage itself.
//
// Every key is declared once in PREFS with its default and its normalizer, and the accessors below are
// one line each: a hand-written load/mutate/save pair per key drifted (the theme default and its
// corrupt-value fallback had come to disagree) and put each key's validation in two places.
//
// Almost everything lives in one JSON blob under `glissa-ui-prefs`. The review sidebar's width is the
// exception: it predates this module and keeps its own key so an operator's saved width survives.

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

// One declaration per key: what it defaults to, and the rule that makes a stored value usable. The
// same normalizer runs on read and on write, so a corrupt blob and a bad caller land in the same place.
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

// Rail width in px, or null for the CSS default. Clamping lives at the consumer (focus-view.js).
export const getRailWidth = () => read('railWidth');
export const setRailWidth = (px: number | null) => write('railWidth', px);

// Known project paths (every project Glissa has seen). A known path with no live session stays in the
// Focus rail as an empty group so the operator re-adds a session via the header "+" without re-picking
// the folder. Persisted across reloads (config.json no longer lists a removed session, so this is the
// only record the empty rail group survives on).
export const getKeptProjects = () => read('keptProjects');
export const setKeptProjects = (paths: string[]) => write('keptProjects', paths);

// The identity of the update the operator dismissed (the latest commit sha, or the version string when
// no sha is known). Persisted rather than page-scoped so a dismissed banner stays dismissed across
// reloads until a NEWER tip arrives.
export const getDismissedUpdate = () => read('dismissedUpdate');
export const setDismissedUpdate = (key: string | null) => write('dismissedUpdate', key);

// The attention signature (public/attention-ack-core.mjs) each dot was last acknowledged against, one
// key per surface. Persisted rather than page-scoped: a dot the operator cleared must stay clear across
// a reload until the facts behind it change.
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

// Review sidebar width in px, or null for the CSS default. Its own storage key, not part of the blob
// above: the value predates this module and re-homing it would silently reset every existing install.
// Clamping lives at the consumer (sidebar/review-sidebar.js), matching getRailWidth.
export const getSidebarWidth = () => asNullableNumber(getJSON(SIDEBAR_WIDTH_KEY, null));
export const setSidebarWidth = (px: number | null) => setJSON(SIDEBAR_WIDTH_KEY, asNullableNumber(px));
