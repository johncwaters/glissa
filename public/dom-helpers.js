// ── DOM helpers ──────────────────────────────────────────────
// Shared utility for creating DOM elements.

export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// Returns the write promise, or null when the Clipboard API is absent
// (insecure context): callers decide whether silence or a toast fits.
export function writeClipboardText(text) {
  if (!navigator.clipboard?.writeText) return null;
  return navigator.clipboard.writeText(text);
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
