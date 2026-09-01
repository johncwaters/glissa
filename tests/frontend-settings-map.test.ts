import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { DASHBOARD_SETTING_PATHS } from '../server/control-handlers.ts';
import { MEMORY_SPEC, MILL_METRICS_SPEC, PACK_DISTILLER_SPEC, INGEST_SPEC } from '../server/core/settings-mill-core.ts';
import * as settingsRanges from '../shared/settings-ranges.ts';
import type { MillBlockSpec } from '../server/core/settings-mill-core.ts';
import type { SettingsSetting } from '../public/settings-map.ts';

const loadMap = () => import('../public/settings-map.ts');

const DASHBOARD_SETTING_PATH_SET = new Set(DASHBOARD_SETTING_PATHS);
const OPTION_CATALOGS = new Set(['sounds', 'themes']);

function specAllows(spec: MillBlockSpec, parts: readonly string[]): boolean {
  if (parts.length === 0) return true;
  const [key, ...remaining] = parts;
  if (spec.booleans.includes(key) && remaining.length === 0) return true;
  if (Object.hasOwn(spec.integerRanges, key) && remaining.length === 0) return true;
  const block = spec.blocks[key];
  if (!block) return false;
  return specAllows(block, remaining);
}

const DEFAULT_CONFIG_RECORD: Record<string, unknown> = DEFAULT_CONFIG;
const MILL_SPECS_BY_KEY: Record<string, MillBlockSpec> = { memory: MEMORY_SPEC, millMetrics: MILL_METRICS_SPEC, packDistiller: PACK_DISTILLER_SPEC, ingest: INGEST_SPEC };

function walkPath(root: unknown, parts: readonly string[]): boolean {
  let cursor = root;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) return false;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return true;
}

function pathIsKnown(path: string): boolean {
  if (path.startsWith('pref:')) return true;
  const [topLevel, ...remaining] = path.split('.');
  if (Object.hasOwn(DEFAULT_CONFIG_RECORD, topLevel)) {
    return walkPath(DEFAULT_CONFIG_RECORD[topLevel], remaining);
  }
  if (DASHBOARD_SETTING_PATH_SET.has(path)) return true;
  const millSpec = MILL_SPECS_BY_KEY[topLevel];
  return !!millSpec && specAllows(millSpec, remaining);
}

function pathExistsInDefaultConfig(path: string): boolean {
  return walkPath(DEFAULT_CONFIG_RECORD, path.split('.'));
}

test('the map has unique ids, known paths, range-backed numbers and searchable keywords', async () => {
  const { SETTINGS_MAP } = await loadMap();
  const sectionIds = new Set();
  const settingIds = new Set();
  for (const section of SETTINGS_MAP) {
    assert.equal(sectionIds.has(section.id), false, `duplicate section id ${section.id}`);
    sectionIds.add(section.id);
    const sectionSettings: SettingsSetting[] = section.settings;
    for (const setting of sectionSettings) {
      assert.equal(settingIds.has(setting.id), false, `duplicate setting id ${setting.id}`);
      settingIds.add(setting.id);
      assert.equal(pathIsKnown(setting.path), true, `unknown path ${setting.path}`);
      assert.ok(Array.isArray(setting.keywords) && setting.keywords.length >= 2, `${setting.id} needs keywords`);
      if (setting.control === 'number') assert.ok(setting.range && Object.hasOwn(settingsRanges, setting.range), `${setting.id} needs a shared range`);
      if (setting.optionsFrom) assert.equal(OPTION_CATALOGS.has(setting.optionsFrom), true, `${setting.id} needs a known option catalog`);
    }
  }
});

test('the map exposes no mill measurement controls', async () => {
  const { SETTINGS_MAP } = await loadMap();
  const paths = SETTINGS_MAP.flatMap<SettingsSetting>((section) => section.settings).map((setting) => setting.path);
  assert.equal(paths.some((path) => path.startsWith('millMetrics.')), false);
});

test('the map never exposes remote and memory keys stay inside the dashboard allow-list', async () => {
  const { SETTINGS_MAP } = await loadMap();
  const settings = SETTINGS_MAP.flatMap<SettingsSetting>((section) => section.settings);
  assert.equal(settings.some((setting) => setting.path === 'remote' || setting.path.startsWith('remote.')), false);
  for (const setting of settings.filter((entry) => entry.path.startsWith('memory.'))) {
    assert.equal(specAllows(MEMORY_SPEC, setting.path.split('.').slice(1)), true, setting.path);
  }
  assert.equal(pathIsKnown('visions.dispatch.quietMS'), false);
});

test('aliases resolve without shadowing canonical section ids', async () => {
  const { SETTINGS_MAP, SETTINGS_SECTION_ALIASES } = await loadMap();
  const sectionIds = new Set(SETTINGS_MAP.map((section) => section.id));
  for (const [alias, sectionId] of Object.entries(SETTINGS_SECTION_ALIASES)) {
    assert.equal(sectionIds.has(alias), false, `${alias} shadows a section id`);
    assert.equal(sectionIds.has(sectionId), true, `${alias} resolves to missing ${sectionId}`);
  }
});

test('file-only paths exist in defaults and never enter a dirty payload', async () => {
  const { SETTINGS_MAP } = await loadMap();
  const { collectDirtyBlocks, hydrateFromSettings } = await import('../public/settings-view-core.ts');
  const allSettings = SETTINGS_MAP.flatMap<SettingsSetting>((section) => section.settings);
  const fileOnlySettings = allSettings.filter((setting) => setting.fileOnly);
  const original = hydrateFromSettings(SETTINGS_MAP, DEFAULT_CONFIG);
  const edited = hydrateFromSettings(SETTINGS_MAP, DEFAULT_CONFIG);
  for (const setting of fileOnlySettings) {
    assert.equal(pathExistsInDefaultConfig(setting.path), true, setting.path);
    edited[setting.path] = 'changed';
  }
  assert.deepEqual(collectDirtyBlocks(SETTINGS_MAP, original, edited), {});
});
