// ── DOM helpers ──────────────────────────────────────────────
// Shared utility for creating DOM elements.

export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
