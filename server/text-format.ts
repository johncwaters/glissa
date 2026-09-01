// Display-only formatting shared by the CLIs and the lane log lines. Nothing here is parsed back.

function shortVersion(version: unknown): string {
  return typeof version === 'string' ? version.slice(0, 12) : '-';
}

function trimIso(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

// Accepts either an ISO string or an epoch-millisecond number, so a caller holding one or the other
// needs no conversion of its own.
function formatTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return trimIso(new Date(value).toISOString());
  if (typeof value === 'string') return trimIso(value);
  return '-';
}

export { formatTimestamp, shortVersion };
