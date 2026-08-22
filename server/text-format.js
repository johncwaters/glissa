'use strict';

// Display-only formatting shared by the CLIs and the lane log lines. Nothing here is parsed back.

function shortVersion(version) {
  return typeof version === 'string' ? version.slice(0, 12) : '-';
}

// Accepts either an ISO string or an epoch-millisecond number, so a caller holding one or the other
// needs no conversion of its own.
function formatTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return trimIso(new Date(value).toISOString());
  if (typeof value === 'string') return trimIso(value);
  return '-';
}

function trimIso(iso) {
  return iso.replace('T', ' ').slice(0, 19);
}

module.exports = { formatTimestamp, shortVersion };
