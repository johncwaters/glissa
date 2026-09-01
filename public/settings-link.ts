import { el } from './dom-helpers.ts';

export function createSettingsLink(sectionId: string, settingId: string, label: string) {
  const link = el('a', 'settings-link', label);
  link.href = `#settings/${encodeURIComponent(sectionId)}/${encodeURIComponent(settingId)}`;
  return link;
}
