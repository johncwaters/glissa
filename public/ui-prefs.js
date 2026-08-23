// ── UI preferences ───────────────────────────────────────────
// THE home for browser-side UI state, so no surface reaches for localStorage itself.
//
// Every key is declared once in PREFS with its default and its normalizer, and the accessors below are
// one line each: a hand-written load/mutate/save pair per key drifted (the theme default and its
// corrupt-value fallback had come to disagree) and put each key's validation in two places.
//
// Almost everything lives in one JSON blob under `glissa-ui-prefs`. The review sidebar's width is the
// exception: it predates this module and keeps its own key so an operator's saved width survives.

import { getJSON, setJSON } from './local-store.js';

const STORAGE_KEY = 'glissa-ui-prefs';
const SIDEBAR_WIDTH_KEY = 'glissa:sidebar-width';

const asBoolean = (fallback) => (value) => (typeof value === 'boolean' ? value : fallback);
const asString = (fallback) => (value) => (typeof value === 'string' ? value : fallback);
const asNullableString = (value) => (typeof value === 'string' && value ? value : null);
const asNullableNumber = (value) => (Number.isFinite(value) ? value : null);
const asStringList = (value) => (Array.isArray(value) ? [...new Set(value.filter((entry) => typeof entry === 'string' && entry))] : []);

// One declaration per key: what it defaults to, and the rule that makes a stored value usable. The
// same normalizer runs on read and on write, so a corrupt blob and a bad caller land in the same place.
const PREFS = {
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

function load() {
  const stored = getJSON(STORAGE_KEY, {});
  const prefs = {};
  for (const [key, normalize] of Object.entries(PREFS)) {
    prefs[key] = normalize(stored?.[key]);
  }
  return prefs;
}

function read(key) {
  return load()[key];
}

function write(key, value) {
  const prefs = load();
  prefs[key] = PREFS[key](value);
  setJSON(STORAGE_KEY, prefs);
}

export const isSoundEnabled = () => read('soundEnabled');
export const setSoundEnabled = (enabled) => write('soundEnabled', enabled);

export const getSoundId = () => read('soundId');
export const setSoundId = (id) => write('soundId', id);

export const isNotificationsEnabled = () => read('notificationsEnabled');
export const setNotificationsEnabled = (enabled) => write('notificationsEnabled', enabled);

export const getThemeId = () => read('themeId');
export const setThemeId = (id) => write('themeId', id);

export const getActiveView = () => read('activeView');
export const setActiveView = (view) => write('activeView', view);

// Rail width in px, or null for the CSS default. Clamping lives at the consumer (focus-view.js).
export const getRailWidth = () => read('railWidth');
export const setRailWidth = (px) => write('railWidth', px);

// Known project paths (every project Glissa has seen). A known path with no live session stays in the
// Focus rail as an empty group so the operator re-adds a session via the header "+" without re-picking
// the folder. Persisted across reloads (config.json no longer lists a removed session, so this is the
// only record the empty rail group survives on).
export const getKeptProjects = () => read('keptProjects');
export const setKeptProjects = (paths) => write('keptProjects', paths);

// The identity of the update the operator dismissed (the latest commit sha, or the version string when
// no sha is known). Persisted rather than page-scoped so a dismissed banner stays dismissed across
// reloads until a NEWER tip arrives.
export const getDismissedUpdate = () => read('dismissedUpdate');
export const setDismissedUpdate = (key) => write('dismissedUpdate', key);

// The attention signature (public/attention-ack-core.mjs) each dot was last acknowledged against, one
// key per surface. Persisted rather than page-scoped: a dot the operator cleared must stay clear across
// a reload until the facts behind it change.
export const getRadarAttentionAck = () => read('radarAttentionAck');
export const setRadarAttentionAck = (signature) => write('radarAttentionAck', signature);

export const getPrsAttentionAck = () => read('prsAttentionAck');
export const setPrsAttentionAck = (signature) => write('prsAttentionAck', signature);

export const getUsageAttentionAck = () => read('usageAttentionAck');
export const setUsageAttentionAck = (signature) => write('usageAttentionAck', signature);

export const getMillAttentionAck = () => read('millAttentionAck');
export const setMillAttentionAck = (signature) => write('millAttentionAck', signature);

export const getLastFocusedSessionId = () => read('lastFocusedSessionId');
export const setLastFocusedSessionId = (id) => write('lastFocusedSessionId', id);

// Review sidebar width in px, or null for the CSS default. Its own storage key, not part of the blob
// above: the value predates this module and re-homing it would silently reset every existing install.
// Clamping lives at the consumer (sidebar/review-sidebar.js), matching getRailWidth.
export const getSidebarWidth = () => asNullableNumber(getJSON(SIDEBAR_WIDTH_KEY, null));
export const setSidebarWidth = (px) => setJSON(SIDEBAR_WIDTH_KEY, asNullableNumber(px));
