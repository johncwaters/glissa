import { el } from './dom-helpers.js';

export function createSettingsLink(sectionId, settingId, label) {
  const link = el('a', 'settings-link', label);
  link.href = `#settings/${encodeURIComponent(sectionId)}/${encodeURIComponent(settingId)}`;
  return link;
}
