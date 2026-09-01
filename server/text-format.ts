function shortVersion(version: unknown): string {
  return typeof version === 'string' ? version.slice(0, 12) : '-';
}

function trimIso(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

function formatTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return trimIso(new Date(value).toISOString());
  if (typeof value === 'string') return trimIso(value);
  return '-';
}

export { formatTimestamp, shortVersion };
