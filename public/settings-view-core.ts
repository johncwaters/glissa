import type { SettingsRange } from '#shared/settings-ranges.ts';
import type { SettingsOption, SettingsSection, SettingsSetting } from './settings-map.ts';
import { unionProjectSelection } from './settings-projects-core.ts';

export type SettingsValues = Record<string, unknown>;

export interface SettingsPayload {
  prefs?: Record<string, unknown>;
  projectChoices?: unknown;
  [key: string]: unknown;
}

export interface SettingsProject {
  id: string;
  path?: string;
  name?: string;
  agent?: string;
  permissionMode?: string;
  packs?: string[];
  recordNames?: string[];
}

const payloadByHydratedValues = new WeakMap<object, unknown>();

export const SECRET_PRESENCE_SUFFIX = 'Configured';
export const STORED_SECRET_MASK = '\u2022'.repeat(12);

function isSecretSetting(setting: SettingsSetting) {
  return setting.control === 'password';
}

function secretPresencePath(setting: SettingsSetting) {
  return `${setting.path}${SECRET_PRESENCE_SUFFIX}`;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(cloneValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]));
}

function valueAtPath(source: unknown, path: string): unknown {
  let value: unknown = source;
  for (const part of path.split('.')) {
    if (value == null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function deleteValueAtPath(target: unknown, path: string) {
  const parts = path.split('.');
  let cursor: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object') return;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (cursor && typeof cursor === 'object') delete (cursor as Record<string, unknown>)[parts.at(-1) as string];
}

function setValueAtPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1) as string] = cloneValue(value);
}

function settingsOf(map: readonly SettingsSection[]): SettingsSetting[] {
  return map.flatMap((section) => section.settings || []);
}

function isReadOnlySetting(setting: SettingsSetting) {
  return setting.fileOnly || setting.control === 'readonly' || setting.control === 'pack-toggles';
}

function searchTokens(value: unknown) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function fieldScore(tokens: string[], queryTokens: string[], weight: number) {
  if (!queryTokens.every((token) => tokens.includes(token))) return 0;
  return queryTokens.length * weight;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return (left as unknown[]).every((value, index) => valuesEqual(value, (right as unknown[])[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key)
    && valuesEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function displayValue(setting: SettingsSetting, value: unknown): unknown {
  if (setting.valueKind !== 'posthog-projects') return cloneValue(value);
  if (Array.isArray(value)) return value.join(', ');
  return value ?? 'all';
}

function wireValue(setting: SettingsSetting, value: unknown): unknown {
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

function hydratedPayload(values: SettingsValues): SettingsPayload | null {
  return (payloadByHydratedValues.get(values) || null) as SettingsPayload | null;
}

export function hydrateFromSettings(map: readonly SettingsSection[], settingsPayload: SettingsPayload = {}): SettingsValues {
  const values: SettingsValues = {};
  for (const setting of settingsOf(map)) {
    if (isReadOnlySetting(setting)) continue;
    if (setting.path.startsWith('pref:')) {
      const preferenceName = setting.path.slice(5);
      const preferenceValue = settingsPayload.prefs?.[preferenceName] ?? settingsPayload[setting.path];
      values[setting.path] = displayValue(setting, preferenceValue ?? setting.defaultValue);
      continue;
    }
    if (isSecretSetting(setting)) {
      const isStored = valueAtPath(settingsPayload, secretPresencePath(setting)) === true;
      values[setting.path] = isStored ? STORED_SECRET_MASK : '';
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
  map: readonly SettingsSection[],
  settingsPayload: SettingsPayload,
  currentOriginal: SettingsValues | null | undefined,
  currentEdited: SettingsValues | null | undefined,
  options: { rehydrateSectionIds?: string[] } = {},
) {
  const { rehydrateSectionIds = [] } = options;
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

export function collectDirtyBlocks(map: readonly SettingsSection[], original: SettingsValues, edited: SettingsValues): SettingsPayload {
  const changedSettings = settingsOf(map).filter((setting) => {
    if (isReadOnlySetting(setting)) return false;
    if (setting.path.startsWith('pref:')) return false;
    if (isSecretSetting(setting) && edited[setting.path] === STORED_SECRET_MASK) return false;
    return !valuesEqual(original[setting.path], edited[setting.path]);
  });
  if (changedSettings.length === 0) return {};

  const originalPayload = hydratedPayload(original) || {};
  const projectChoices: { id?: unknown }[] = Array.isArray(originalPayload.projectChoices) ? originalPayload.projectChoices : [];
  const renderedProjectIds = projectChoices.map((project) => project.id).filter((id): id is string => typeof id === 'string');
  const payload: SettingsPayload = {};
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
    let value: unknown = wireValue(setting, edited[setting.path]);
    if (setting.control === 'projects') {
      const storedSelection = original[setting.path];
      value = unionProjectSelection({
        checked: Array.isArray(value) ? value : [],
        stored: Array.isArray(storedSelection) ? storedSelection : [],
        rendered: renderedProjectIds,
      });
    }
    setValueAtPath(payload, setting.path, value);
    if (setting.path === 'memory.retainDays' && valueAtPath(originalPayload, 'memory.memoryRetainDays') != null) {
      setValueAtPath(payload, 'memory.memoryRetainDays', value);
    }
  }
  for (const setting of settingsOf(map)) {
    if (!isSecretSetting(setting)) continue;
    deleteValueAtPath(payload, secretPresencePath(setting));
  }
  return payload;
}

function rangeMessage(range: SettingsRange, setting: SettingsSetting) {
  const noun = setting.integer === false ? 'number' : 'whole number';
  if (range.exclusiveMin) return `Must be a positive ${noun}.`;
  if (range.max == null) return `Must be a ${noun} of at least ${range.min}.`;
  return `Must be a ${noun} between ${range.min} and ${range.max}.`;
}

function numberError(setting: SettingsSetting, rawValue: unknown, settingsRanges: Record<string, SettingsRange>) {
  if (setting.nullable && (rawValue == null || String(rawValue).trim() === '')) return null;
  const value = Number(rawValue);
  const range = settingsRanges[setting.range ?? ''];
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

function posthogProjectsError(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text || text.toLowerCase() === 'all') return null;
  const ids = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (ids.length > 0 && ids.every((id) => /^\d+$/.test(id) && Number(id) > 0)) return null;
  return 'Must be "all" or a comma-separated list of positive numeric ids.';
}

export function validateLocally(map: readonly SettingsSection[], edited: SettingsValues, settingsRanges: Record<string, SettingsRange> = {}) {
  const errors: Record<string, string> = {};
  for (const setting of settingsOf(map)) {
    if (isReadOnlySetting(setting)) continue;
    let error: string | null = null;
    if (setting.control === 'number') error = numberError(setting, edited[setting.path], settingsRanges);
    if (setting.valueKind === 'posthog-projects') error = posthogProjectsError(edited[setting.path]);
    if (setting.control === 'select' && !(setting.options as SettingsOption[]).some((option) => option.value === edited[setting.path])) {
      error = 'Choose one of the available options.';
    }
    if (error) errors[setting.id] = error;
  }
  return errors;
}

export function sectionsByLevel(map: readonly SettingsSection[]): Record<string, SettingsSection[]> {
  const grouped: Record<string, SettingsSection[]> = { browser: [], machine: [], lanes: [], projects: [] };
  for (const section of map) {
    if (!grouped[section.level]) grouped[section.level] = [];
    grouped[section.level].push(section);
  }
  return grouped;
}

export function scoreSettingsSearch(map: readonly SettingsSection[], query: unknown) {
  const queryTokens = searchTokens(query);
  if (queryTokens.length === 0) return [];
  const results: { section: SettingsSection; setting: SettingsSetting; score: number }[] = [];
  for (const section of map) {
    const sectionTokens = searchTokens(section.title);
    for (const setting of section.settings || []) {
      const titleScore = fieldScore(searchTokens(setting.title), queryTokens, 1000);
      const keywordScore = fieldScore(searchTokens((setting.keywords || []).join(' ')), queryTokens, 100);
      const sectionScore = fieldScore(sectionTokens, queryTokens, 10);
      const descriptionScore = fieldScore(searchTokens(setting.description), queryTokens, 1);
      const score = titleScore + keywordScore + sectionScore + descriptionScore;
      if (score === 0) continue;
      results.push({ section, setting, score });
    }
  }
  return results
    .sort((left, right) => right.score - left.score
      || left.section.title.localeCompare(right.section.title)
      || left.setting.title.localeCompare(right.setting.title))
    .slice(0, 30);
}

export function parseSettingsHash(hash: unknown, map: readonly SettingsSection[], aliases: Record<string, string> = {}) {
  const match = /^#settings\/([^/]+)(?:\/([^/]+))?$/.exec(String(hash || ''));
  if (!match) return null;
  let requestedSectionId: string;
  let requestedSettingId: string | null;
  try {
    requestedSectionId = decodeURIComponent(match[1]);
    requestedSettingId = match[2] ? decodeURIComponent(match[2]) : null;
  } catch {
    return null;
  }
  const sectionId = aliases[requestedSectionId] || requestedSectionId;
  const section = map.find((entry) => entry.id === sectionId);
  if (!section) return null;
  const setting = requestedSettingId
    ? (section.settings || []).find((entry) => entry.id === requestedSettingId)
    : null;
  if (requestedSettingId && !setting) return null;
  return {
    sectionId,
    settingId: setting?.id || null,
    hash: `#settings/${sectionId}${setting ? `/${setting.id}` : ''}`,
  };
}

export function orderSections(map: readonly SettingsSection[]): SettingsSection[] {
  const unattendedId = 'lanes-unattended';
  const unattended = map.find((section) => section.id === unattendedId);
  if (!unattended) return [...map];
  const ordered = map.filter((section) => section.id !== unattendedId);
  const lastLaneIndex = ordered.findLastIndex((section) => section.level === 'lanes');
  ordered.splice(lastLaneIndex + 1, 0, unattended);
  return ordered;
}

function projectSetting(projectId: string, suffix: string, fields: Omit<SettingsSetting, 'id' | 'projectId'>): SettingsSetting {
  return {
    id: `project-${projectId}-${suffix}`,
    projectId,
    ...fields,
  };
}

function canonicalProjectRecordName(name: unknown) {
  return String(name || '').replace(/\s+\(\d+\)$/, '');
}

function projectPathBasename(projectPath: unknown) {
  const normalizedPath = String(projectPath || '').replace(/[\\/]+$/, '');
  return normalizedPath.split(/[\\/]/).at(-1) || '';
}

function projectSectionTitle(project: SettingsProject): string {
  return projectPathBasename(project?.path)
    || canonicalProjectRecordName(project?.name)
    || project?.id;
}

export function buildProjectSections(projects: SettingsProject[] = [], packs: { group?: unknown; name?: unknown }[] = []): SettingsSection[] {
  const packNames = packs
    .filter((pack) => !pack?.group && typeof pack?.name === 'string' && pack.name)
    .map((pack) => pack.name as string);
  return projects
    .filter((project) => typeof project?.id === 'string' && project.id)
    .map((project) => ({
      id: `project-${project.id}`,
      level: 'projects',
      title: projectSectionTitle(project),
      description: 'Settings scoped to this configured project.',
      caption: (project.recordNames?.length ?? 0) > 1 ? `Cards: ${project.recordNames?.join(', ')}` : '',
      project,
      settings: [
        projectSetting(project.id, 'packs', {
          path: `project:${project.id}:packs`,
          title: 'Context packs',
          description: 'Packs delivered on the next session spawn.',
          control: 'pack-toggles',
          keywords: ['context', 'delivery'],
          options: packNames,
          value: Array.isArray(project.packs) ? project.packs : [],
        }),
        projectSetting(project.id, 'agent', {
          path: `project:${project.id}:agent`,
          title: 'Agent',
          description: 'Agent configured for this project.',
          control: 'readonly',
          keywords: ['cli', 'runtime'],
          value: project.agent || 'Not available in the current dashboard payload',
        }),
        projectSetting(project.id, 'permission-mode', {
          path: `project:${project.id}:permission-mode`,
          title: 'Default permission mode',
          description: 'Permission mode used for newly spawned sessions.',
          control: 'readonly',
          keywords: ['approval', 'sandbox'],
          value: project.permissionMode || 'Not available in the current dashboard payload',
        }),
        projectSetting(project.id, 'codex-hook-trust', {
          path: `projects.${project.id}.codexBypassHookTrust`,
          title: 'Codex hook trust bypass',
          description: 'Configured only on this project record.',
          control: 'readonly',
          keywords: ['hooks', 'codex'],
          fileOnly: true,
        }),
      ],
    }));
}

export function enrichProjectsById(projects: SettingsProject[] = [], details: SettingsProject[] = []): SettingsProject[] {
  const detailsById = new Map(details
    .filter((detail) => typeof detail?.id === 'string' && detail.id)
    .map((detail): [string, SettingsProject] => [detail.id, detail]));
  return projects.map((project) => {
    const matchingDetail = detailsById.get(project?.id);
    const projectPath = project?.path || matchingDetail?.path;
    const recordNames = details
      .filter((detail) => projectPath && detail?.path === projectPath)
      .map((detail) => detail?.name)
      .filter((name): name is string => typeof name === 'string' && name !== '');
    return {
      ...matchingDetail,
      ...project,
      path: projectPath,
      recordNames: [...new Set(recordNames)],
    };
  });
}

export function decideDangerToggle(current: unknown, requested: unknown, typed: unknown, expected: unknown) {
  if (requested !== true) return false;
  if (current === true) return true;
  return String(typed || '').trim() === String(expected || '');
}

export function resolveEntry(map: readonly SettingsSection[], sectionId: string): SettingsSection | null {
  return map.find((section) => section.id === sectionId) || map[0] || null;
}
