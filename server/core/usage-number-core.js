'use strict';

function safeNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value;
}

function numberOrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function stringOrNull(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

module.exports = {
  numberOrNull,
  safeNumber,
  stringOrNull,
};
