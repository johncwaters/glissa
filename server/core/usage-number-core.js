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

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  isPlainObject,
  numberOrNull,
  safeNumber,
  stringOrNull,
};
