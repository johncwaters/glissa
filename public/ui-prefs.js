// ── UI preferences ───────────────────────────────────────────
// Persists browser-side UI state to localStorage.
// Schema: { soundEnabled: boolean, soundId: string, themeId: string, notificationsEnabled: boolean }

import { getJSON, setJSON } from './local-store.js';

const STORAGE_KEY = 'glissa-ui-prefs';
const DEFAULT_PREFS = { soundEnabled: true, soundId: 'coins', themeId: 'phyrexian', notificationsEnabled: true };

function load() {
  const prefs = getJSON(STORAGE_KEY, DEFAULT_PREFS);
  if (typeof prefs.soundEnabled !== 'boolean') prefs.soundEnabled = true;
  if (typeof prefs.soundId !== 'string') prefs.soundId = 'coins';
  if (typeof prefs.themeId !== 'string') prefs.themeId = 'golgari';
  if (typeof prefs.notificationsEnabled !== 'boolean') prefs.notificationsEnabled = true;
  return prefs;
}

function save(prefs) {
  setJSON(STORAGE_KEY, prefs);
}

export function isSoundEnabled() {
  return load().soundEnabled;
}

export function setSoundEnabled(enabled) {
  const prefs = load();
  prefs.soundEnabled = enabled;
  save(prefs);
}

export function getSoundId() {
  return load().soundId;
}

export function setSoundId(id) {
  const prefs = load();
  prefs.soundId = id;
  save(prefs);
}

export function isNotificationsEnabled() {
  return load().notificationsEnabled;
}

export function setNotificationsEnabled(enabled) {
  const prefs = load();
  prefs.notificationsEnabled = enabled;
  save(prefs);
}

export function getThemeId() {
  return load().themeId;
}

export function setThemeId(id) {
  const prefs = load();
  prefs.themeId = id;
  save(prefs);
}

