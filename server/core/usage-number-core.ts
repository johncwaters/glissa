function safeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function isPlainObject(value: unknown): boolean {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export { isPlainObject, numberOrNull, safeNumber, stringOrNull };
