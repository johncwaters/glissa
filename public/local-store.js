// ── localStorage helper ──────────────────────────────────────
// Generic JSON-based localStorage wrapper with graceful degradation.
// All operations are try/catch guarded for private browsing and quota errors.

export function getJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Silently fail — private browsing or quota exceeded
  }
}

export function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Silently fail
  }
}
