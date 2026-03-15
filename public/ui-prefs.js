// ── UI preferences ───────────────────────────────────────────
// Persists browser-side UI state to localStorage.
// Schema: { minimized: string[], soundEnabled: boolean, soundId: string, completedGuides: string[] }

import { getJSON, setJSON } from './local-store.js';

const STORAGE_KEY = 'glissa-ui-prefs';
const DEFAULT_PREFS = { minimized: [], soundEnabled: true, soundId: 'coins', completedGuides: [] };

function load() {
  const prefs = getJSON(STORAGE_KEY, DEFAULT_PREFS);
  if (!Array.isArray(prefs.minimized)) prefs.minimized = [];
  if (typeof prefs.soundEnabled !== 'boolean') prefs.soundEnabled = true;
  if (typeof prefs.soundId !== 'string') prefs.soundId = 'coins';
  if (!Array.isArray(prefs.completedGuides)) prefs.completedGuides = [];
  return prefs;
}

function save(prefs) {
  setJSON(STORAGE_KEY, prefs);
}

export function isMinimized(name) {
  return load().minimized.includes(name);
}

export function setMinimized(name, minimized) {
  const prefs = load();
  const idx = prefs.minimized.indexOf(name);
  if (minimized && idx === -1) {
    prefs.minimized.push(name);
  } else if (!minimized && idx !== -1) {
    prefs.minimized.splice(idx, 1);
  }
  save(prefs);
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

export function getCompletedGuides() {
  return load().completedGuides;
}

export function addCompletedGuide(id) {
  const prefs = load();
  if (!prefs.completedGuides.includes(id)) {
    prefs.completedGuides.push(id);
    save(prefs);
  }
}

export function pruneStale(validNames) {
  const prefs = load();
  const validSet = new Set(validNames);
  prefs.minimized = prefs.minimized.filter(name => validSet.has(name));
  save(prefs);
}
