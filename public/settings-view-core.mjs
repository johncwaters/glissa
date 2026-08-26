import { unionProjectSelection } from './settings-projects-core.mjs';

const payloadByHydratedValues = new WeakMap();

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]));
}

function valueAtPath(source, path) {
  let value = source;
  for (const part of path.split('.')) {
    if (value == null || typeof value !== 'object') return undefined;
    value = value[part];
  }
  return value;
}

function setValueAtPath(target, path, value) {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = cloneValue(value);
}

function settingsOf(map) {
  return map.flatMap((section) => section.settings || []);
}

function valuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && valuesEqual(left[key], right[key]));
}

function displayValue(setting, value) {
  if (setting.valueKind !== 'posthog-projects') return cloneValue(value);
  if (Array.isArray(value)) return value.join(', ');
  return value ?? 'all';
}

function wireValue(setting, value) {
  if (setting.control === 'number') {
    if (setting.nullable && (value == null || String(value).trim() === '')) return null;
    const number = Number(value);
    if (setting.zeroIsNull && number <= 0) return null;
    return number;
  }
  if (setting.valueKind === 'posthog-projects') {
    const text = String(value ?? '').trim();
    if (!text || text.toLowerCase() === 'all') return 'all';
    return text.split(',').map((part) => Number(part.trim())).filter(Number.isFinite);
  }
  if (setting.control === 'text' || setting.control === 'password') return String(value ?? '').trim();
  return cloneValue(value);
}

function hydratedPayload(values) {
  return payloadByHydratedValues.get(values) || null;
}

export function hydrateFromSettings(map, settingsPayload = {}) {
  const values = {};
  for (const setting of settingsOf(map)) {
    if (setting.path.startsWith('pref:')) {
      const preferenceName = setting.path.slice(5);
      const preferenceValue = settingsPayload.prefs?.[preferenceName] ?? settingsPayload[setting.path];
      values[setting.path] = displayValue(setting, preferenceValue ?? setting.defaultValue);
      continue;
    }
    let value = valueAtPath(settingsPayload, setting.path);
    if (setting.path === 'memory.retainDays') {
      value = valueAtPath(settingsPayload, 'memory.memoryRetainDays') ?? value;
    }
    values[setting.path] = displayValue(setting, value ?? setting.defaultValue);
  }
  payloadByHydratedValues.set(values, cloneValue(settingsPayload));
  return values;
}

export function rehydratePreservingDirtySections(
  map,
  settingsPayload,
  currentOriginal,
  currentEdited,
  { rehydrateSectionIds = [] } = {},
) {
  const original = hydrateFromSettings(map, settingsPayload);
  const edited = hydrateFromSettings(map, settingsPayload);
  if (!currentOriginal || !currentEdited) return { original, edited };
  const forcedSections = new Set(rehydrateSectionIds);
  for (const section of map) {
    if (forcedSections.has(section.id)) continue;
    const isDirty = section.settings.some((setting) => {
      if (setting.path.startsWith('pref:')) return false;
      return !valuesEqual(currentOriginal[setting.path], currentEdited[setting.path]);
    });
    if (!isDirty) continue;
    for (const setting of section.settings) {
      original[setting.path] = cloneValue(currentOriginal[setting.path]);
      edited[setting.path] = cloneValue(currentEdited[setting.path]);
    }
  }
  return { original, edited };
}

export function collectDirtyBlocks(map, original, edited) {
  const changedSettings = settingsOf(map).filter((setting) => {
    if (setting.path.startsWith('pref:')) return false;
    return !valuesEqual(original[setting.path], edited[setting.path]);
  });
  if (changedSettings.length === 0) return {};

  const originalPayload = hydratedPayload(original) || {};
  const projectChoices = Array.isArray(originalPayload.projectChoices) ? originalPayload.projectChoices : [];
  const renderedProjectIds = projectChoices.map((project) => project.id).filter((id) => typeof id === 'string');
  const payload = {};
  const initializedBlocks = new Set();

  for (const setting of changedSettings) {
    const [topLevel] = setting.path.split('.');
    if (!setting.path.includes('.')) {
      payload[topLevel] = wireValue(setting, edited[setting.path]);
      continue;
    }
    if (!initializedBlocks.has(topLevel)) {
      const storedBlock = originalPayload[topLevel];
      payload[topLevel] = storedBlock && typeof storedBlock === 'object' && !Array.isArray(storedBlock)
        ? cloneValue(storedBlock)
        : {};
      initializedBlocks.add(topLevel);
    }
    let value = wireValue(setting, edited[setting.path]);
    if (setting.control === 'projects') {
      value = unionProjectSelection({
        checked: Array.isArray(value) ? value : [],
        stored: Array.isArray(original[setting.path]) ? original[setting.path] : [],
        rendered: renderedProjectIds,
      });
    }
    setValueAtPath(payload, setting.path, value);
    if (setting.path === 'memory.retainDays' && valueAtPath(originalPayload, 'memory.memoryRetainDays') != null) {
      setValueAtPath(payload, 'memory.memoryRetainDays', value);
    }
  }
  return payload;
}

function rangeMessage(range, setting) {
  const noun = setting.integer === false ? 'number' : 'whole number';
  if (range.exclusiveMin) return `Must be a positive ${noun}.`;
  if (range.max == null) return `Must be a ${noun} of at least ${range.min}.`;
  return `Must be a ${noun} between ${range.min} and ${range.max}.`;
}

function numberError(setting, rawValue, settingsRanges) {
  if (setting.nullable && (rawValue == null || String(rawValue).trim() === '')) return null;
  const value = Number(rawValue);
  const range = settingsRanges[setting.range];
  if (!range) return 'Allowed range is unavailable.';
  if (!Number.isFinite(value)) return rangeMessage(range, setting);
  if (setting.integer !== false && !Number.isInteger(value)) return rangeMessage(range, setting);
  if (range.exclusiveMin && value <= range.min) {
    if (setting.zeroIsNull && value <= 0) return null;
    return rangeMessage(range, setting);
  }
  if (!range.exclusiveMin && value < range.min) return rangeMessage(range, setting);
  if (range.max != null && value > range.max) return rangeMessage(range, setting);
  return null;
}

function posthogProjectsError(value) {
  const text = String(value ?? '').trim();
  if (!text || text.toLowerCase() === 'all') return null;
  const ids = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (ids.length > 0 && ids.every((id) => /^\d+$/.test(id) && Number(id) > 0)) return null;
  return 'Must be "all" or a comma-separated list of positive numeric ids.';
}

export function validateLocally(map, edited, settingsRanges = {}) {
  const errors = {};
  for (const setting of settingsOf(map)) {
    let error = null;
    if (setting.control === 'number') error = numberError(setting, edited[setting.path], settingsRanges);
    if (setting.valueKind === 'posthog-projects') error = posthogProjectsError(edited[setting.path]);
    if (setting.control === 'select' && !setting.options.some((option) => option.value === edited[setting.path])) {
      error = 'Choose one of the available options.';
    }
    if (error) errors[setting.id] = error;
  }
  return errors;
}

export function sectionsByLevel(map) {
  const grouped = { browser: [], machine: [], lanes: [], projects: [] };
  for (const section of map) {
    if (!grouped[section.level]) grouped[section.level] = [];
    grouped[section.level].push(section);
  }
  return grouped;
}

export function resolveEntry(map, sectionId) {
  return map.find((section) => section.id === sectionId) || map[0] || null;
}
