import type { SettingsRange } from '#shared/settings-ranges.ts';
import { SETTINGS_RANGES } from '#shared/settings-ranges.ts';
import { playAlertSound, SOUND_OPTIONS } from './alert-sound.ts';
import { sendControlRequest } from './control-ws.ts';
import { el } from './dom-helpers.ts';
import { DELIVER_TO_CAP_NOTE, deliverToCapHint, deliveryTargets, packDeltaFor } from './mill-view-core.ts';
import { ensureNotificationPermission, notificationPermission, notificationsSupported } from './notifications.ts';
import type { SettingsSection, SettingsSetting, SettingsOption } from './settings-map.ts';
import { SETTINGS_MAP, SETTINGS_SECTION_ALIASES } from './settings-map.ts';
import {
  buildProjectSections,
  collectDirtyBlocks,
  decideDangerToggle,
  enrichProjectsById,
  hydrateFromSettings,
  orderSections,
  parseSettingsHash,
  rehydratePreservingDirtySections,
  resolveEntry,
  scoreSettingsSearch,
  sectionsByLevel,
  validateLocally,
} from './settings-view-core.ts';
import type { SettingsPayload, SettingsProject, SettingsValues } from './settings-view-core.ts';
import { SHORTCUT_GROUPS } from './shortcuts.ts';
import { applyTheme, getThemeList } from './theme.ts';
import {
  getSoundId,
  getThemeId,
  isNotificationsEnabled,
  setNotificationsEnabled,
  setSoundId,
  setThemeId,
} from './ui-prefs.ts';
import { usageStatusLines } from './usage-panel.ts';

const RANGES_BY_NAME: Record<string, SettingsRange> = SETTINGS_RANGES;

interface SearchResult {
  section: SettingsSection;
  setting: SettingsSetting;
  score: number;
}

const OPTION_CATALOGS: Readonly<Record<string, { id: string; label: string }[]>> = Object.freeze({
  sounds: SOUND_OPTIONS,
  themes: getThemeList(),
});

function resolveSettingOptions(setting: SettingsSetting): SettingsSetting {
  if (!setting.optionsFrom) return setting;
  const catalog = OPTION_CATALOGS[setting.optionsFrom] || [];
  return {
    ...setting,
    options: catalog.map((option) => ({ value: option.id, label: option.label })),
  };
}

const STATIC_SETTINGS_VIEW_MAP = Object.freeze(SETTINGS_MAP.map((section) => ({
  ...section,
  settings: section.settings.map(resolveSettingOptions),
})));

let SETTINGS_VIEW_MAP = orderSections(STATIC_SETTINGS_VIEW_MAP);

const LEVEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  browser: 'This browser',
  machine: 'Machine',
  lanes: 'Lanes',
  projects: 'Projects',
});

let rootEl: HTMLElement | null = null;
let shellEl: HTMLDivElement | null = null;
let navigationEl: HTMLElement | null = null;
let searchEl: HTMLInputElement | null = null;
let sectionButtonEl: HTMLButtonElement | null = null;
let sectionButtonTitleEl: HTMLSpanElement | null = null;
let sectionButtonLevelEl: HTMLSpanElement | null = null;
let sectionPickerEl: HTMLDivElement | null = null;
let phoneSearchResultsEl: HTMLElement | null = null;
let contentEl: HTMLDivElement | null = null;
let selectedSection: SettingsSection = SETTINGS_VIEW_MAP[0];
let settingsPayload: SettingsPayload = {};
let projectReport: {
  projects: SettingsProject[];
  packs: { group?: unknown; name?: unknown }[];
  maxPacksPerProject: unknown;
} = { projects: [], packs: [], maxPacksPerProject: null };
const projectDetailsById = new Map<string, SettingsProject>();
let originalValues: SettingsValues | null = null;
let editedValues: SettingsValues | null = null;
let serverError = '';
let searchQuery = '';
const dangerConfirmationBySettingId = new Map<string, string>();
let dangerConfirmationFocusSettingId: string | null = null;
let sectionPickerDocumentClickHandler: ((event: MouseEvent) => void) | null = null;
let sectionPickerDocumentKeydownHandler: ((event: KeyboardEvent) => void) | null = null;

function browserPreferences() {
  return {
    themeId: getThemeId(),
    soundId: getSoundId(),
    notificationsEnabled: isNotificationsEnabled(),
  };
}

function hydrate(payload: SettingsPayload) {
  const source = { ...payload, prefs: browserPreferences() };
  originalValues = hydrateFromSettings(SETTINGS_VIEW_MAP, source);
  editedValues = hydrateFromSettings(SETTINGS_VIEW_MAP, source);
}

function settingValue(setting: SettingsSetting): unknown {
  if (setting.control === 'readonly' || setting.control === 'pack-toggles') return setting.value;
  return editedValues?.[setting.path] ?? setting.defaultValue;
}

function sectionIsDirty(section: SettingsSection) {
  return section.settings.some((setting) => {
    if (setting.path.startsWith('pref:')) return false;
    return JSON.stringify(originalValues?.[setting.path]) !== JSON.stringify(editedValues?.[setting.path]);
  });
}

function settingsHash(sectionId: string, settingId: string | null = null) {
  return `#settings/${encodeURIComponent(sectionId)}${settingId ? `/${encodeURIComponent(settingId)}` : ''}`;
}

function replaceSettingsHash(sectionId: string, settingId: string | null = null) {
  history.replaceState(history.state, '', settingsHash(sectionId, settingId));
}

function flashSetting(settingId: string) {
  requestAnimationFrame(() => {
    const heading = document.getElementById(settingId);
    const row = heading?.closest('.settings-view-setting');
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.remove('settings-view-setting-flash');
    requestAnimationFrame(() => row.classList.add('settings-view-setting-flash'));
  });
}

function rebuildSettingsMap() {
  const previousSectionId = selectedSection?.id;
  const projectSections = buildProjectSections(projectReport.projects, projectReport.packs);
  SETTINGS_VIEW_MAP = orderSections([...STATIC_SETTINGS_VIEW_MAP, ...projectSections]);
  selectedSection = resolveEntry(SETTINGS_VIEW_MAP, selectedSection?.id) ?? selectedSection;
  if (previousSectionId === selectedSection?.id) return;
  dangerConfirmationBySettingId.clear();
  dangerConfirmationFocusSettingId = null;
}

function rememberProjectDetails(projects: unknown) {
  const rows: SettingsProject[] = Array.isArray(projects) ? projects : [];
  for (const project of rows) {
    if (typeof project?.id !== 'string' || !project.id) continue;
    projectDetailsById.set(project.id, {
      ...projectDetailsById.get(project.id),
      ...project,
    });
  }
  projectReport.projects = enrichProjectsById(projectReport.projects, [...projectDetailsById.values()]);
}

function renderShortcutGroups(container: HTMLElement) {
  for (const group of SHORTCUT_GROUPS) {
    const groupEl = el('div', 'shortcut-group');
    groupEl.appendChild(el('div', 'shortcut-group-title', group.title));
    const rows = el('dl', 'shortcut-rows');
    for (const item of group.items) {
      const keys = el('dt', 'shortcut-keys');
      item.combos.forEach((chord, chordIndex) => {
        if (chordIndex > 0) keys.appendChild(el('span', 'shortcut-sep', '/'));
        chord.forEach((caption, keyIndex) => {
          if (keyIndex > 0) keys.appendChild(el('span', 'shortcut-sep', '+'));
          keys.appendChild(el('kbd', 'kbd', caption));
        });
      });
      rows.append(keys, el('dd', 'shortcut-label', item.label));
    }
    groupEl.appendChild(rows);
    container.appendChild(groupEl);
  }
}

function renderAbout(container: HTMLElement) {
  const about = el('div', 'settings-about');
  const version = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? `v${__APP_VERSION__}` : 'version unknown';
  const versionEl = el('span', 'settings-about-version', 'GLISSA ');
  versionEl.appendChild(el('span', 'settings-about-v', version));
  const links = el('span', 'settings-about-links');
  const repo = el('a', 'settings-about-link', 'GitHub');
  repo.href = 'https://github.com/johncwaters/glissa';
  repo.target = '_blank';
  repo.rel = 'noopener';
  const changelog = el('a', 'settings-about-link', 'Changelog');
  changelog.href = 'https://github.com/johncwaters/glissa/blob/main/CHANGELOG.md';
  changelog.target = '_blank';
  changelog.rel = 'noopener';
  links.append(repo, changelog);
  about.append(versionEl, links);
  container.appendChild(about);
}

function applyBrowserPreference(setting: SettingsSetting, value: unknown) {
  if (setting.path === 'pref:themeId') {
    setThemeId(value as string);
    applyTheme(value as string);
    return;
  }
  if (setting.path === 'pref:soundId') {
    setSoundId(value as string);
    playAlertSound(value as string);
    return;
  }
  if (setting.path !== 'pref:notificationsEnabled') return;
  setNotificationsEnabled(value as boolean);
  if (value) ensureNotificationPermission().then(renderContent);
}

function refreshFooter() {
  if (!contentEl || !editedValues) return;
  contentEl.querySelector('.settings-view-footer')?.remove();
  const errors = validateLocally([selectedSection], editedValues, SETTINGS_RANGES);
  const footer = renderFooter(errors);
  if (footer) contentEl.appendChild(footer);
}

function setEditedValue(setting: SettingsSetting, value: unknown, { rerender = true }: { rerender?: boolean } = {}) {
  if (!editedValues) return;
  editedValues[setting.path] = value;
  serverError = '';
  if (setting.path.startsWith('pref:') && originalValues) {
    originalValues[setting.path] = value;
    applyBrowserPreference(setting, value);
  }
  if (rerender) {
    renderContent();
    return;
  }
  refreshFooter();
}

function inputMinimum(setting: SettingsSetting, range: SettingsRange) {
  if (!range.exclusiveMin) return range.min;
  if (setting.integer === false) return undefined;
  return range.min + 1;
}

function renderToggle(setting: SettingsSetting) {
  const wrapper = el('div', 'settings-view-toggle-wrap');
  const label = el('label', 'settings-view-toggle');
  const input = el('input', 'settings-view-checkbox');
  input.type = 'checkbox';
  input.checked = settingValue(setting) === true;
  if (setting.id === 'desktop-notifications' && !notificationsSupported()) {
    input.checked = false;
    input.disabled = true;
  }
  input.setAttribute('aria-labelledby', setting.id);
  input.addEventListener('change', () => {
    if (!setting.dangerConfirmation) {
      setEditedValue(setting, input.checked);
      return;
    }
    const typed = dangerConfirmationBySettingId.get(setting.id) || '';
    const next = decideDangerToggle(settingValue(setting), input.checked, typed, setting.dangerConfirmation);
    if (next === input.checked) {
      dangerConfirmationBySettingId.delete(setting.id);
      setEditedValue(setting, next);
      return;
    }
    dangerConfirmationBySettingId.set(setting.id, typed);
    dangerConfirmationFocusSettingId = setting.id;
    renderContent();
  });
  label.append(input, el('span', 'settings-view-toggle-state', input.checked ? 'On' : 'Off'));
  wrapper.appendChild(label);
  if (!setting.dangerConfirmation || input.checked || !dangerConfirmationBySettingId.has(setting.id)) return wrapper;
  const confirmation = el('input', 'settings-view-input settings-view-danger-confirm');
  confirmation.type = 'text';
  confirmation.value = dangerConfirmationBySettingId.get(setting.id) || '';
  confirmation.placeholder = `Type ${setting.dangerConfirmation}`;
  confirmation.setAttribute('aria-label', `Type ${setting.dangerConfirmation} to confirm`);
  confirmation.addEventListener('input', () => {
    dangerConfirmationBySettingId.set(setting.id, confirmation.value);
    const next = decideDangerToggle(false, true, confirmation.value, setting.dangerConfirmation);
    if (!next) return;
    dangerConfirmationBySettingId.delete(setting.id);
    setEditedValue(setting, true);
  });
  wrapper.appendChild(confirmation);
  if (dangerConfirmationFocusSettingId === setting.id) {
    dangerConfirmationFocusSettingId = null;
    requestAnimationFrame(() => confirmation.focus());
  }
  return wrapper;
}

function renderInput(setting: SettingsSetting) {
  const input = el('input', 'settings-view-input');
  input.type = setting.control ?? 'text';
  input.value = String(settingValue(setting) ?? '');
  if (setting.control === 'password') input.placeholder = 'No credential stored';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-labelledby', setting.id);
  input.addEventListener('input', () => setEditedValue(setting, input.value, { rerender: false }));
  return input;
}

function renderNumber(setting: SettingsSetting) {
  const input = el('input', 'settings-view-input');
  const range = RANGES_BY_NAME[setting.range ?? ''];
  input.type = 'number';
  input.value = String(settingValue(setting) ?? '');
  input.step = String(setting.step ?? 1);
  const minimum = inputMinimum(setting, range);
  if (minimum != null) input.min = String(minimum);
  if (range.max != null) input.max = String(range.max);
  input.autocomplete = 'off';
  input.setAttribute('aria-labelledby', setting.id);
  input.addEventListener('input', () => setEditedValue(setting, input.value, { rerender: false }));
  return input;
}

function renderSelect(setting: SettingsSetting) {
  const select = el('select', 'settings-view-input');
  select.setAttribute('aria-labelledby', setting.id);
  for (const choice of setting.options as SettingsOption[]) {
    const option = el('option', null, choice.label);
    option.value = choice.value;
    select.appendChild(option);
  }
  select.value = String(settingValue(setting));
  select.addEventListener('change', () => setEditedValue(setting, select.value));
  return select;
}

function renderList(setting: SettingsSetting) {
  const wrapper = el('div', 'settings-view-list');
  const currentValue = settingValue(setting);
  const values: string[] = Array.isArray(currentValue) ? currentValue : [];
  if (values.length === 0) wrapper.appendChild(el('div', 'settings-empty', 'No repository roots configured.'));
  for (const [index, value] of values.entries()) {
    const row = el('div', 'settings-root-item');
    const pathEl = el('span', 'settings-root-path', value);
    pathEl.title = value;
    const remove = el('button', 'btn-settings-remove', String.fromCharCode(0xd7));
    remove.type = 'button';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove ${value}`);
    remove.addEventListener('click', () => {
      setEditedValue(setting, values.filter((_entry, currentIndex) => currentIndex !== index));
    });
    row.append(pathEl, remove);
    wrapper.appendChild(row);
  }
  const addRow = el('div', 'settings-add-row');
  const input = el('input', 'settings-view-input settings-root-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Repository root path';
  const add = el('button', 'btn-dialog btn-dialog-confirm btn-settings-add', 'Add');
  add.type = 'button';
  const addValue = () => {
    const value = input.value.trim();
    if (!value) return;
    if (values.some((entry) => entry.toLowerCase() === value.toLowerCase())) return;
    setEditedValue(setting, [...values, value]);
  };
  add.addEventListener('click', addValue);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addValue();
  });
  addRow.append(input, add);
  wrapper.appendChild(addRow);
  return wrapper;
}

function renderProjects(setting: SettingsSetting) {
  const wrapper = el('div', 'settings-view-projects');
  const currentValue = settingValue(setting);
  const selected = new Set<string>(Array.isArray(currentValue) ? currentValue : []);
  const choices: { id: string; name: string }[] = Array.isArray(settingsPayload.projectChoices) ? settingsPayload.projectChoices : [];
  if (choices.length === 0) wrapper.appendChild(el('div', 'settings-empty', 'No configured projects are available.'));
  for (const project of choices) {
    const label = el('label', 'settings-view-project-choice');
    const input = el('input', 'settings-view-checkbox');
    input.type = 'checkbox';
    input.checked = selected.has(project.id);
    input.addEventListener('change', () => {
      const next = new Set(selected);
      if (input.checked) next.add(project.id);
      if (!input.checked) next.delete(project.id);
      setEditedValue(setting, [...next]);
    });
    label.append(input, document.createTextNode(project.name));
    wrapper.appendChild(label);
  }
  return wrapper;
}

function renderFileOnly(setting: SettingsSetting) {
  const block = el('div', 'settings-view-file-only');
  block.append(el('code', 'settings-view-key-path', setting.path));
  block.append(el('span', 'settings-view-file-caption', 'Configured in config.json'));
  return block;
}

function renderReadonly(setting: SettingsSetting) {
  return el('div', 'settings-readonly', String(setting.value || 'Not configured'));
}

function renderPackToggles(setting: SettingsSetting) {
  const wrapper = el('div', 'settings-view-projects');
  const packNames = setting.options as string[];
  if (packNames.length === 0) wrapper.appendChild(el('div', 'settings-empty', 'No packs are available.'));
  for (const packName of packNames) {
    const target = deliveryTargets(projectReport, { name: packName })
      .find((candidate) => candidate.id === setting.projectId);
    if (!target) continue;
    const label = el('label', 'settings-view-project-choice');
    const input = el('input', 'settings-view-checkbox');
    input.type = 'checkbox';
    input.checked = target.checked;
    input.disabled = target.disabled;
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        const message = await sendControlRequest('set-project-packs', {
          ...packDeltaFor(target, packName),
        });
        if (message.ok === true) return;
        input.checked = target.checked;
        input.disabled = target.disabled;
        serverError = String(message.error || 'Could not change pack delivery.');
        renderContent();
      } catch (error) {
        input.checked = target.checked;
        input.disabled = target.disabled;
        serverError = (error as Error)?.message || 'Could not change pack delivery.';
        renderContent();
      }
    });
    label.append(input, document.createTextNode(packName));
    if (target.disabled) label.appendChild(el('span', 'mill-deliver-note', DELIVER_TO_CAP_NOTE));
    wrapper.appendChild(label);
  }
  const capHint = deliverToCapHint(projectReport);
  if (capHint) wrapper.appendChild(el('div', 'settings-readonly', capHint));
  return wrapper;
}

function renderControl(setting: SettingsSetting) {
  if (setting.fileOnly) return renderFileOnly(setting);
  if (setting.control === 'readonly') return renderReadonly(setting);
  if (setting.control === 'pack-toggles') return renderPackToggles(setting);
  if (setting.control === 'toggle') return renderToggle(setting);
  if (setting.control === 'number') return renderNumber(setting);
  if (setting.control === 'select') return renderSelect(setting);
  if (setting.control === 'list') return renderList(setting);
  if (setting.control === 'projects') return renderProjects(setting);
  return renderInput(setting);
}

function statusText(setting: SettingsSetting) {
  if (setting.id === 'desktop-notifications' && !notificationsSupported()) {
    return 'Desktop notifications are unavailable for this page.';
  }
  if (setting.id === 'desktop-notifications' && settingValue(setting) && notificationPermission() === 'denied') {
    return 'Blocked by the browser. Allow notifications for this site to enable them.';
  }
  if (setting.status !== 'rtk-install' || !settingValue(setting) || settingsPayload.rtkAvailable) return '';
  const install = (settingsPayload.rtkInstall || { status: 'idle' }) as { status?: string; reason?: string };
  if (install.status === 'installing') return 'No rtk binary found. Glissa is installing it into ~/.glissa/bin now.';
  if (install.status === 'failed') return `No rtk binary found. The last install attempt failed: ${install.reason || 'unknown reason'}. Glissa retries on the next save.`;
  return 'No rtk binary found. Glissa will install it into ~/.glissa/bin when you save.';
}

function buildStatusSlot(setting: SettingsSetting) {
  if (setting.status === 'usage-last-report') return buildUsageStatus();
  const status = statusText(setting);
  if (!status) return null;
  return el('div', 'settings-view-warning settings-view-status-slot', status);
}

function renderSettingHeading(setting: SettingsSetting) {
  const row = el('div', 'settings-view-setting-heading');
  const heading = el('h2', 'settings-view-setting-title', setting.title);
  heading.id = setting.id;
  heading.addEventListener('click', () => replaceSettingsHash(selectedSection.id, setting.id));
  const copy = el('button', 'settings-view-copy-link', '#');
  copy.type = 'button';
  copy.setAttribute('aria-label', 'Copy link');
  const copyStatus = el('span', 'settings-view-copy-status');
  copyStatus.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    const url = new URL(settingsHash(selectedSection.id, setting.id), location.href).href;
    try {
      await navigator.clipboard.writeText(url);
      copyStatus.textContent = 'Link copied';
    } catch {
      copyStatus.textContent = 'Copy failed';
    }
    setTimeout(() => { copyStatus.textContent = ''; }, 1600);
  });
  row.append(heading, copy, copyStatus);
  return row;
}

function renderSetting(setting: SettingsSetting, errors: Record<string, string>) {
  const article = el('article', 'settings-view-setting');
  article.append(renderSettingHeading(setting), el('p', 'settings-view-setting-description', setting.description));
  article.appendChild(renderControl(setting));
  if (setting.danger && setting.warning) article.appendChild(el('div', 'settings-view-warning settings-warning', setting.warning));
  const statusSlot = buildStatusSlot(setting);
  if (statusSlot) article.appendChild(statusSlot);
  if (errors[setting.id]) article.appendChild(el('div', 'settings-view-field-error', errors[setting.id]));
  return article;
}

function revertSelectedSection() {
  if (!editedValues || !originalValues) return;
  for (const setting of selectedSection.settings) {
    editedValues[setting.path] = structuredClone(originalValues[setting.path]);
  }
  serverError = '';
  renderContent();
}

async function saveSelectedSection() {
  const section = selectedSection;
  const sectionMap = [section];
  const errors = validateLocally(sectionMap, editedValues ?? {}, SETTINGS_RANGES);
  if (Object.keys(errors).length > 0) {
    serverError = 'Fix the highlighted settings before saving.';
    renderContent();
    return;
  }
  const settings = collectDirtyBlocks(sectionMap, originalValues ?? {}, editedValues ?? {});
  if (Object.keys(settings).length === 0) return;
  try {
    const message = await sendControlRequest('update-settings', { settings });
    if (message.type === 'settings-error') {
      if (selectedSection !== section) return;
      serverError = String(message.message);
      renderContent();
      return;
    }
    if (message.settings) {
      applySettingsBroadcast(message.settings, { rehydrateSectionIds: [section.id] });
    }
  } catch (error) {
    if (selectedSection !== section) return;
    serverError = (error as Error)?.message || 'Failed to save settings.';
    renderContent();
  }
}

function renderFooter(errors: Record<string, string>) {
  const isDirty = sectionIsDirty(selectedSection);
  if (selectedSection.level === 'browser') return null;
  if (!isDirty && !serverError) return null;
  const footer = el('footer', 'settings-view-footer');
  const message = el('div', 'settings-view-footer-error', serverError);
  message.setAttribute('role', 'status');
  footer.appendChild(message);
  if (!isDirty) return footer;
  const actions = el('div', 'settings-view-footer-actions');
  const revert = el('button', 'btn-dialog btn-dialog-cancel', 'Revert');
  revert.type = 'button';
  revert.addEventListener('click', revertSelectedSection);
  const save = el('button', 'btn-dialog btn-dialog-confirm', 'Save');
  save.type = 'button';
  save.disabled = Object.keys(errors).length > 0;
  save.addEventListener('click', saveSelectedSection);
  actions.append(revert, save);
  footer.appendChild(actions);
  return footer;
}

function buildUsageStatus() {
  const block = el('div', 'settings-view-status-block settings-view-status-slot');
  block.appendChild(el('div', 'settings-section-title', 'Last report'));
  const lines = usageStatusLines();
  for (const line of lines) block.appendChild(el('div', 'settings-readonly', line));
  return block;
}

function renderContent() {
  if (!contentEl || !editedValues) return;
  contentEl.textContent = '';
  const header = el('header', 'settings-view-section-header');
  const titleRow = el('div', 'settings-view-title-row');
  const title = el('h1', 'settings-view-section-title', selectedSection.title);
  title.tabIndex = -1;
  title.addEventListener('click', () => replaceSettingsHash(selectedSection.id));
  titleRow.append(title);
  titleRow.append(el('span', 'settings-view-level', LEVEL_LABELS[selectedSection.level] || selectedSection.level));
  header.append(titleRow, el('p', 'settings-view-section-description', selectedSection.description));
  if (selectedSection.caption) header.appendChild(el('p', 'settings-view-section-caption', selectedSection.caption));
  contentEl.appendChild(header);

  if (selectedSection.id === 'browser-shortcuts') {
    const groups = el('div', 'shortcut-groups settings-view-shortcuts');
    renderShortcutGroups(groups);
    contentEl.appendChild(groups);
    renderAbout(contentEl);
    return;
  }

  const errors = validateLocally([selectedSection], editedValues, SETTINGS_RANGES);
  const stack = el('div', 'settings-view-stack');
  for (const setting of selectedSection.settings) stack.appendChild(renderSetting(setting, errors));
  for (const link of selectedSection.unattendedLinks || []) {
    const row = el('div', 'settings-view-unattended-link');
    row.append(document.createTextNode(`${link.title}: `));
    const anchor = el('a', null, 'Enabled in Unattended actions');
    anchor.href = settingsHash('lanes-unattended', link.settingId);
    row.appendChild(anchor);
    stack.appendChild(row);
  }
  contentEl.appendChild(stack);
  const footer = renderFooter(errors);
  if (footer) contentEl.appendChild(footer);
}

function selectSection(
  sectionId: string,
  { focusContent = false, settingId = null, updateHash = true }: { focusContent?: boolean; settingId?: string | null; updateHash?: boolean } = {}
) {
  const previousSectionId = selectedSection?.id;
  selectedSection = resolveEntry(SETTINGS_VIEW_MAP, sectionId) ?? selectedSection;
  if (previousSectionId !== selectedSection?.id) {
    dangerConfirmationBySettingId.clear();
    dangerConfirmationFocusSettingId = null;
  }
  serverError = '';
  markCurrentSection(navigationEl);
  markCurrentSection(sectionPickerEl);
  if (sectionButtonTitleEl) {
    sectionButtonTitleEl.textContent = selectedSection.title;
    if (sectionButtonEl) sectionButtonEl.title = selectedSection.title;
  }
  if (sectionButtonLevelEl) sectionButtonLevelEl.textContent = LEVEL_LABELS[selectedSection.level] || selectedSection.level;
  renderContent();
  if (updateHash) replaceSettingsHash(selectedSection.id, settingId);
  if (settingId) flashSetting(settingId);
  if (focusContent) contentEl?.querySelector('h1')?.focus();
}

function markCurrentSection(container: Element | null) {
  for (const button of container?.querySelectorAll<HTMLElement>('[data-settings-section]') || []) {
    const selected = button.dataset.settingsSection === selectedSection.id;
    button.setAttribute('aria-current', selected ? 'page' : 'false');
  }
}

function chooseSearchResult(searchResult: SearchResult) {
  setSectionPickerOpen(false);
  if (!searchEl) return;
  searchEl.value = '';
  searchQuery = '';
  renderNavigation();
  selectSection(searchResult.section.id, { settingId: searchResult.setting.id });
}

function appendSearchResults(target: HTMLElement, results: SearchResult[]) {
  if (results.length === 0) {
    target.appendChild(el('div', 'settings-empty settings-view-search-empty', 'No settings found.'));
    return;
  }
  const resultsBySection = new Map<string, SearchResult[]>();
  for (const result of results) {
    if (!resultsBySection.has(result.section.id)) resultsBySection.set(result.section.id, []);
    resultsBySection.get(result.section.id)?.push(result);
  }
  for (const sectionResults of resultsBySection.values()) {
    const section = sectionResults[0].section;
    const group = el('div', 'settings-view-nav-group');
    group.appendChild(el('div', 'settings-view-nav-label', `${section.title} (${LEVEL_LABELS[section.level]})`));
    for (const result of sectionResults) {
      const button = el('button', 'settings-view-nav-item settings-view-search-result', result.setting.title);
      button.type = 'button';
      button.addEventListener('click', () => chooseSearchResult(result));
      group.appendChild(button);
    }
    target.appendChild(group);
  }
}

function appendSectionGroups(
  container: HTMLElement,
  grouped: Record<string, SettingsSection[]>,
  { groupClassName, headingClassName, createButton }: { groupClassName: string; headingClassName: string; createButton: (section: SettingsSection) => HTMLElement }
) {
  for (const level of ['browser', 'machine', 'lanes', 'projects']) {
    if (grouped[level].length === 0) continue;
    const group = el('div', groupClassName);
    group.appendChild(el('div', headingClassName, LEVEL_LABELS[level]));
    for (const section of grouped[level]) group.appendChild(createButton(section));
    container.appendChild(group);
  }
}

function renderSectionPicker(grouped: Record<string, SettingsSection[]>) {
  if (!sectionPickerEl) return;
  sectionPickerEl.textContent = '';
  appendSectionGroups(sectionPickerEl, grouped, {
    groupClassName: 'settings-view-section-picker-group',
    headingClassName: 'settings-view-section-picker-heading',
    createButton(section: SettingsSection) {
      const button = el('button', 'settings-view-section-option', section.title);
      button.type = 'button';
      button.dataset.settingsSection = section.id;
      button.addEventListener('click', () => {
        setSectionPickerOpen(false);
        selectSection(section.id);
      });
      return button;
    },
  });
  markCurrentSection(sectionPickerEl);
}

function isSectionPickerOpen() {
  return !!sectionPickerEl && !sectionPickerEl.hidden;
}

function setSectionPickerOpen(isOpen: boolean, { returnFocus = true }: { returnFocus?: boolean } = {}) {
  if (!sectionPickerEl || !sectionButtonEl) return;
  const wasOpen = isSectionPickerOpen();
  sectionPickerEl.hidden = !isOpen;
  sectionButtonEl.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) {
    renderSectionPicker(sectionsByLevel(SETTINGS_VIEW_MAP));
    requestAnimationFrame(() => {
      const currentSectionButton = sectionPickerEl?.querySelector('[aria-current="page"]');
      if (!(currentSectionButton instanceof HTMLElement)) return;
      currentSectionButton.focus();
    });
    return;
  }
  if (returnFocus && wasOpen) sectionButtonEl.focus();
}

function renderNavigation() {
  if (!navigationEl || !phoneSearchResultsEl || !shellEl) return;
  const grouped = sectionsByLevel(SETTINGS_VIEW_MAP);
  navigationEl.textContent = '';
  phoneSearchResultsEl.textContent = '';
  shellEl.dataset.searching = String(Boolean(searchQuery));
  phoneSearchResultsEl.hidden = !searchQuery;
  if (searchQuery) {
    const results = scoreSettingsSearch(SETTINGS_VIEW_MAP, searchQuery);
    appendSearchResults(navigationEl, results);
    appendSearchResults(phoneSearchResultsEl, results);
    return;
  }
  appendSectionGroups(navigationEl, grouped, {
    groupClassName: 'settings-view-nav-group',
    headingClassName: 'settings-view-nav-label',
    createButton(section: SettingsSection) {
      const button = el('button', 'settings-view-nav-item', section.title);
      button.type = 'button';
      button.dataset.settingsSection = section.id;
      button.addEventListener('click', () => selectSection(section.id));
      return button;
    },
  });
  renderSectionPicker(grouped);
  selectSection(selectedSection.id, { updateHash: false });
}

function handleNavigationKeydown(event: KeyboardEvent) {
  if (searchQuery && event.key === 'Enter') {
    const first = scoreSettingsSearch(SETTINGS_VIEW_MAP, searchQuery)[0];
    if (!first) return;
    event.preventDefault();
    chooseSearchResult(first);
    return;
  }
  if (event.key === 'Escape' && searchQuery) {
    if (!searchEl) return;
    event.preventDefault();
    searchEl.value = '';
    searchQuery = '';
    renderNavigation();
    searchEl.focus();
    return;
  }
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  if (!navigationEl) return;
  const buttons = [...navigationEl.querySelectorAll('[data-settings-section]')]
    .filter((button): button is HTMLElement => button instanceof HTMLElement);
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;
  const currentIndex = buttons.indexOf(activeElement);
  if (currentIndex < 0) return;
  event.preventDefault();
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  buttons[(currentIndex + direction + buttons.length) % buttons.length].focus();
}

export function mountSettingsView(container: HTMLElement) {
  rootEl = container;
  rootEl.textContent = '';
  shellEl = el('div', 'settings-view-shell');
  const sidebar = el('div', 'settings-view-sidebar');
  searchEl = el('input', 'settings-view-search');
  searchEl.type = 'search';
  searchEl.placeholder = 'Search settings';
  searchEl.setAttribute('aria-label', 'Search settings');
  navigationEl = el('nav', 'settings-view-nav');
  navigationEl.setAttribute('role', 'navigation');
  navigationEl.setAttribute('aria-label', 'Settings sections');
  sectionButtonEl = el('button', 'settings-view-section-button');
  sectionButtonEl.type = 'button';
  sectionButtonEl.setAttribute('aria-expanded', 'false');
  sectionButtonEl.setAttribute('aria-controls', 'settings-section-picker');
  sectionButtonTitleEl = el('span', 'settings-view-section-button-title');
  sectionButtonLevelEl = el('span', 'settings-view-section-button-level');
  const sectionButtonChevron = el('span', 'settings-view-section-button-chevron', String.fromCharCode(0x2304));
  sectionButtonChevron.setAttribute('aria-hidden', 'true');
  sectionButtonEl.append(sectionButtonTitleEl, sectionButtonLevelEl, sectionButtonChevron);
  sectionPickerEl = el('div', 'settings-view-section-picker');
  sectionPickerEl.id = 'settings-section-picker';
  sectionPickerEl.hidden = true;
  sectionPickerEl.setAttribute('role', 'dialog');
  sectionPickerEl.setAttribute('aria-label', 'Settings sections');
  phoneSearchResultsEl = el('nav', 'settings-view-phone-results');
  phoneSearchResultsEl.hidden = true;
  phoneSearchResultsEl.setAttribute('aria-label', 'Settings search results');
  contentEl = el('div', 'settings-view-content');
  contentEl.setAttribute('aria-live', 'polite');
  searchEl.addEventListener('input', () => {
    const currentSearchEl = searchEl;
    if (!currentSearchEl) return;
    searchQuery = currentSearchEl.value.trim();
    renderNavigation();
  });
  searchEl.addEventListener('keydown', handleNavigationKeydown);
  navigationEl.addEventListener('keydown', handleNavigationKeydown);
  phoneSearchResultsEl.addEventListener('keydown', handleNavigationKeydown);
  sectionButtonEl.addEventListener('click', () => setSectionPickerOpen(!isSectionPickerOpen()));
  if (sectionPickerDocumentClickHandler) document.removeEventListener('click', sectionPickerDocumentClickHandler);
  if (sectionPickerDocumentKeydownHandler) document.removeEventListener('keydown', sectionPickerDocumentKeydownHandler);
  sectionPickerDocumentClickHandler = (event) => {
    if (!isSectionPickerOpen()) return;
    if (!(event.target instanceof Node)) return;
    if (sectionPickerEl?.contains(event.target) || sectionButtonEl?.contains(event.target)) return;
    setSectionPickerOpen(false);
  };
  sectionPickerDocumentKeydownHandler = (event) => {
    if (event.key !== 'Escape' || !isSectionPickerOpen()) return;
    event.preventDefault();
    setSectionPickerOpen(false);
  };
  document.addEventListener('click', sectionPickerDocumentClickHandler);
  document.addEventListener('keydown', sectionPickerDocumentKeydownHandler);
  sidebar.append(searchEl, sectionButtonEl, navigationEl, sectionPickerEl);
  shellEl.append(sidebar, phoneSearchResultsEl, contentEl);
  rootEl.appendChild(shellEl);
  hydrate(settingsPayload);
  renderNavigation();
}

export function closeSettingsSectionPicker({ returnFocus = true }: { returnFocus?: boolean } = {}) {
  setSectionPickerOpen(false, { returnFocus });
}

export function activateSettingsSection(sectionId: string | null = null, settingId: string | null = null) {
  selectSection(sectionId || selectedSection.id, { settingId });
}

export function resolveSettingsTarget(hash: unknown) {
  return parseSettingsHash(hash, SETTINGS_VIEW_MAP, SETTINGS_SECTION_ALIASES);
}

export function applySettingsBroadcast(freshSettings: unknown, options: { rehydrateSectionIds?: string[] } = {}) {
  const { rehydrateSectionIds = [] } = options;
  if (!freshSettings) return;
  settingsPayload = freshSettings as SettingsPayload;
  rememberProjectDetails(settingsPayload.projectChoices);
  rebuildSettingsMap();
  const source = { ...settingsPayload, prefs: browserPreferences() };
  const hydrated = rehydratePreservingDirtySections(
    SETTINGS_VIEW_MAP,
    source,
    originalValues,
    editedValues,
    { rehydrateSectionIds },
  );
  originalValues = hydrated.original;
  editedValues = hydrated.edited;
  serverError = '';
  if (navigationEl) renderNavigation();
  renderContent();
}

export function refreshSettingsStatus() {
  for (const setting of selectedSection.settings || []) {
    if (!setting.status) continue;
    const row = document.getElementById(setting.id)?.closest('.settings-view-setting');
    if (!row) continue;
    const currentStatus = row?.querySelector('.settings-view-status-slot');
    const nextStatus = buildStatusSlot(setting);
    if (currentStatus && nextStatus) currentStatus.replaceWith(nextStatus);
    if (currentStatus && !nextStatus) currentStatus.remove();
    if (!currentStatus && nextStatus) row.appendChild(nextStatus);
  }
}

export function applySettingsProjectReport(msg: unknown) {
  const report = msg as { error?: unknown; projects?: unknown; packs?: unknown; maxPacksPerProject?: unknown } | null | undefined;
  if (typeof report?.error === 'string' && report.error) return;
  projectReport = {
    projects: enrichProjectsById(
      Array.isArray(report?.projects) ? report.projects : [],
      [...projectDetailsById.values()],
    ),
    packs: Array.isArray(report?.packs) ? report.packs : [],
    maxPacksPerProject: report?.maxPacksPerProject,
  };
  rebuildSettingsMap();
  if (!rootEl) return;
  renderNavigation();
}

export function applySettingsProjects(projects: unknown) {
  rememberProjectDetails(projects);
  rebuildSettingsMap();
  if (navigationEl) renderNavigation();
}
