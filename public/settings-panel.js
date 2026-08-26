import { SETTINGS_RANGES } from '/shared/settings-ranges.mjs';
import { playAlertSound, SOUND_OPTIONS } from './alert-sound.js';
import { sendControlRequest } from './control-ws.js';
import { el } from './dom-helpers.js';
import { ensureNotificationPermission, notificationPermission, notificationsSupported } from './notifications.js';
import { SETTINGS_MAP } from './settings-map.mjs';
import {
  collectDirtyBlocks,
  hydrateFromSettings,
  rehydratePreservingDirtySections,
  resolveEntry,
  sectionsByLevel,
  validateLocally,
} from './settings-view-core.mjs';
import { SHORTCUT_GROUPS } from './shortcuts.mjs';
import { applyTheme, getThemeList } from './theme.js';
import {
  getSoundId,
  getThemeId,
  isNotificationsEnabled,
  setNotificationsEnabled,
  setSoundId,
  setThemeId,
} from './ui-prefs.js';
import { usageStatusLines } from './usage-panel.js';

const OPTION_CATALOGS = Object.freeze({
  sounds: SOUND_OPTIONS,
  themes: getThemeList(),
});

function resolveSettingOptions(setting) {
  if (!setting.optionsFrom) return setting;
  const catalog = OPTION_CATALOGS[setting.optionsFrom] || [];
  return {
    ...setting,
    options: catalog.map((option) => ({ value: option.id, label: option.label })),
  };
}

const SETTINGS_VIEW_MAP = Object.freeze(SETTINGS_MAP.map((section) => ({
  ...section,
  settings: section.settings.map(resolveSettingOptions),
})));

const LEVEL_LABELS = Object.freeze({
  browser: 'This browser',
  machine: 'Machine',
  lanes: 'Lanes',
  projects: 'Projects',
});

let rootEl = null;
let navigationEl = null;
let pickerEl = null;
let contentEl = null;
let selectedSection = SETTINGS_VIEW_MAP[0];
let settingsPayload = {};
let originalValues = null;
let editedValues = null;
let serverError = '';

function browserPreferences() {
  return {
    themeId: getThemeId(),
    soundId: getSoundId(),
    notificationsEnabled: isNotificationsEnabled(),
  };
}

function hydrate(payload) {
  const source = { ...payload, prefs: browserPreferences() };
  originalValues = hydrateFromSettings(SETTINGS_VIEW_MAP, source);
  editedValues = hydrateFromSettings(SETTINGS_VIEW_MAP, source);
}

function settingValue(setting) {
  return editedValues?.[setting.path] ?? setting.defaultValue;
}

function sectionIsDirty(section) {
  return section.settings.some((setting) => {
    if (setting.path.startsWith('pref:')) return false;
    return JSON.stringify(originalValues?.[setting.path]) !== JSON.stringify(editedValues?.[setting.path]);
  });
}

function renderShortcutGroups(container) {
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

function renderAbout(container) {
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

function applyBrowserPreference(setting, value) {
  if (setting.path === 'pref:themeId') {
    setThemeId(value);
    applyTheme(value);
    return;
  }
  if (setting.path === 'pref:soundId') {
    setSoundId(value);
    playAlertSound(value);
    return;
  }
  if (setting.path !== 'pref:notificationsEnabled') return;
  setNotificationsEnabled(value);
  if (value) ensureNotificationPermission().then(renderContent);
}

function refreshFooter() {
  contentEl?.querySelector('.settings-view-footer')?.remove();
  const errors = validateLocally([selectedSection], editedValues, SETTINGS_RANGES);
  const footer = renderFooter(errors);
  if (footer) contentEl.appendChild(footer);
}

function setEditedValue(setting, value, { rerender = true } = {}) {
  editedValues[setting.path] = value;
  serverError = '';
  if (setting.path.startsWith('pref:')) {
    originalValues[setting.path] = value;
    applyBrowserPreference(setting, value);
  }
  if (rerender) {
    renderContent();
    return;
  }
  refreshFooter();
}

function inputMinimum(setting, range) {
  if (!range.exclusiveMin) return range.min;
  if (setting.integer === false) return undefined;
  return range.min + 1;
}

function renderToggle(setting) {
  const label = el('label', 'settings-view-toggle');
  const input = el('input', 'settings-view-checkbox');
  input.type = 'checkbox';
  input.checked = settingValue(setting) === true;
  if (setting.id === 'desktop-notifications' && !notificationsSupported()) {
    input.checked = false;
    input.disabled = true;
  }
  input.setAttribute('aria-labelledby', setting.id);
  input.addEventListener('change', () => setEditedValue(setting, input.checked));
  label.append(input, el('span', 'settings-view-toggle-state', input.checked ? 'On' : 'Off'));
  return label;
}

function renderInput(setting) {
  const input = el('input', 'settings-view-input');
  input.type = setting.control;
  input.value = settingValue(setting) ?? '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-labelledby', setting.id);
  input.addEventListener('input', () => setEditedValue(setting, input.value, { rerender: false }));
  return input;
}

function renderNumber(setting) {
  const input = el('input', 'settings-view-input');
  const range = SETTINGS_RANGES[setting.range];
  input.type = 'number';
  input.value = settingValue(setting) ?? '';
  input.step = String(setting.step ?? 1);
  const minimum = inputMinimum(setting, range);
  if (minimum != null) input.min = String(minimum);
  if (range.max != null) input.max = String(range.max);
  input.autocomplete = 'off';
  input.setAttribute('aria-labelledby', setting.id);
  input.addEventListener('input', () => setEditedValue(setting, input.value, { rerender: false }));
  return input;
}

function renderSelect(setting) {
  const select = el('select', 'settings-view-input');
  select.setAttribute('aria-labelledby', setting.id);
  for (const choice of setting.options) {
    const option = el('option', null, choice.label);
    option.value = choice.value;
    select.appendChild(option);
  }
  select.value = settingValue(setting);
  select.addEventListener('change', () => setEditedValue(setting, select.value));
  return select;
}

function renderList(setting) {
  const wrapper = el('div', 'settings-view-list');
  const values = Array.isArray(settingValue(setting)) ? settingValue(setting) : [];
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

function renderProjects(setting) {
  const wrapper = el('div', 'settings-view-projects');
  const selected = new Set(Array.isArray(settingValue(setting)) ? settingValue(setting) : []);
  const choices = Array.isArray(settingsPayload.projectChoices) ? settingsPayload.projectChoices : [];
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

function renderControl(setting) {
  if (setting.control === 'toggle') return renderToggle(setting);
  if (setting.control === 'number') return renderNumber(setting);
  if (setting.control === 'select') return renderSelect(setting);
  if (setting.control === 'list') return renderList(setting);
  if (setting.control === 'projects') return renderProjects(setting);
  return renderInput(setting);
}

function statusText(setting) {
  if (setting.id === 'desktop-notifications' && !notificationsSupported()) {
    return 'Desktop notifications are unavailable for this page.';
  }
  if (setting.id === 'desktop-notifications' && settingValue(setting) && notificationPermission() === 'denied') {
    return 'Blocked by the browser. Allow notifications for this site to enable them.';
  }
  if (setting.id !== 'rtk-compression' || !settingValue(setting) || settingsPayload.rtkAvailable) return '';
  const install = settingsPayload.rtkInstall || { status: 'idle' };
  if (install.status === 'installing') return 'No rtk binary found. Glissa is installing it into ~/.glissa/bin now.';
  if (install.status === 'failed') return `No rtk binary found. The last install attempt failed: ${install.reason || 'unknown reason'}. Glissa retries on the next save.`;
  return 'No rtk binary found. Glissa will install it into ~/.glissa/bin when you save.';
}

function renderSetting(setting, errors) {
  const article = el('article', 'settings-view-setting');
  const heading = el('h2', 'settings-view-setting-title', setting.title);
  heading.id = setting.id;
  article.append(heading, el('p', 'settings-view-setting-description', setting.description));
  article.appendChild(renderControl(setting));
  const status = statusText(setting);
  if (status) article.appendChild(el('div', 'settings-view-warning', status));
  if (errors[setting.id]) article.appendChild(el('div', 'settings-view-field-error', errors[setting.id]));
  return article;
}

function revertSelectedSection() {
  for (const setting of selectedSection.settings) {
    editedValues[setting.path] = structuredClone(originalValues[setting.path]);
  }
  serverError = '';
  renderContent();
}

async function saveSelectedSection() {
  const section = selectedSection;
  const sectionMap = [section];
  const errors = validateLocally(sectionMap, editedValues, SETTINGS_RANGES);
  if (Object.keys(errors).length > 0) {
    serverError = 'Fix the highlighted settings before saving.';
    renderContent();
    return;
  }
  const settings = collectDirtyBlocks(sectionMap, originalValues, editedValues);
  if (Object.keys(settings).length === 0) return;
  try {
    const message = await sendControlRequest('update-settings', { settings });
    if (message.type === 'settings-error') {
      if (selectedSection !== section) return;
      serverError = message.message;
      renderContent();
      return;
    }
    if (message.settings) {
      applySettingsBroadcast(message.settings, { rehydrateSectionIds: [section.id] });
    }
  } catch (error) {
    if (selectedSection !== section) return;
    serverError = error.message || 'Failed to save settings.';
    renderContent();
  }
}

function renderFooter(errors) {
  if (selectedSection.level === 'browser' || !sectionIsDirty(selectedSection)) return null;
  const footer = el('footer', 'settings-view-footer');
  const message = el('div', 'settings-view-footer-error', serverError);
  message.setAttribute('role', 'status');
  const actions = el('div', 'settings-view-footer-actions');
  const revert = el('button', 'btn-dialog btn-dialog-cancel', 'Revert');
  revert.type = 'button';
  revert.addEventListener('click', revertSelectedSection);
  const save = el('button', 'btn-dialog btn-dialog-confirm', 'Save');
  save.type = 'button';
  save.disabled = Object.keys(errors).length > 0;
  save.addEventListener('click', saveSelectedSection);
  actions.append(revert, save);
  footer.append(message, actions);
  return footer;
}

function buildUsageStatus() {
  const block = el('div', 'settings-view-status-block');
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
  titleRow.append(title);
  titleRow.append(el('span', 'settings-view-level', LEVEL_LABELS[selectedSection.level] || selectedSection.level));
  header.append(titleRow, el('p', 'settings-view-section-description', selectedSection.description));
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
  contentEl.appendChild(stack);
  if (selectedSection.id === 'machine-usage') contentEl.appendChild(buildUsageStatus());
  const footer = renderFooter(errors);
  if (footer) contentEl.appendChild(footer);
}

function selectSection(sectionId, { focusContent = false } = {}) {
  selectedSection = resolveEntry(SETTINGS_VIEW_MAP, sectionId);
  serverError = '';
  for (const button of navigationEl?.querySelectorAll('[data-settings-section]') || []) {
    const selected = button.dataset.settingsSection === selectedSection.id;
    button.setAttribute('aria-current', selected ? 'page' : 'false');
  }
  if (pickerEl) pickerEl.value = selectedSection.id;
  renderContent();
  if (focusContent) contentEl?.querySelector('h1')?.focus();
}

function renderNavigation() {
  const grouped = sectionsByLevel(SETTINGS_VIEW_MAP);
  navigationEl.textContent = '';
  pickerEl.textContent = '';
  for (const level of ['browser', 'machine', 'lanes']) {
    if (grouped[level].length === 0) continue;
    const group = el('div', 'settings-view-nav-group');
    group.appendChild(el('div', 'settings-view-nav-label', LEVEL_LABELS[level]));
    for (const section of grouped[level]) {
      const button = el('button', 'settings-view-nav-item', section.title);
      button.type = 'button';
      button.dataset.settingsSection = section.id;
      button.addEventListener('click', () => selectSection(section.id));
      group.appendChild(button);
      const option = el('option', null, `${LEVEL_LABELS[level]}: ${section.title}`);
      option.value = section.id;
      pickerEl.appendChild(option);
    }
    navigationEl.appendChild(group);
  }
  navigationEl.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const buttons = [...navigationEl.querySelectorAll('[data-settings-section]')];
    const currentIndex = buttons.indexOf(document.activeElement);
    if (currentIndex < 0) return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(currentIndex + direction + buttons.length) % buttons.length].focus();
  });
  pickerEl.addEventListener('change', () => selectSection(pickerEl.value));
  selectSection(selectedSection.id);
}

export function mountSettingsView(container) {
  rootEl = container;
  rootEl.textContent = '';
  const shell = el('div', 'settings-view-shell');
  navigationEl = el('nav', 'settings-view-nav');
  navigationEl.setAttribute('role', 'navigation');
  navigationEl.setAttribute('aria-label', 'Settings sections');
  pickerEl = el('select', 'settings-view-picker');
  pickerEl.setAttribute('aria-label', 'Settings section');
  contentEl = el('div', 'settings-view-content');
  contentEl.setAttribute('aria-live', 'polite');
  shell.append(navigationEl, pickerEl, contentEl);
  rootEl.appendChild(shell);
  hydrate(settingsPayload);
  renderNavigation();
}

export function activateSettingsSection(sectionId) {
  selectSection(sectionId);
}

export function applySettingsBroadcast(freshSettings, { rehydrateSectionIds = [] } = {}) {
  if (!freshSettings) return;
  settingsPayload = freshSettings;
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
  renderContent();
}

export function refreshSettingsStatus() {
  if (selectedSection.id !== 'machine-usage') return;
  const currentStatus = contentEl?.querySelector('.settings-view-status-block');
  if (!currentStatus) return;
  currentStatus.replaceWith(buildUsageStatus());
}
