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

// ── Adoption (move an element, never copy it) ────────────────
// Some elements carry live state that cannot be rebuilt: a session card owns an xterm, the review
// sidebar owns its diff caches and listeners, the header menu owns its wiring. When the phone layout
// wants one of those, it MOVES the original and gives it back afterwards rather than building a second
// copy that would then need its own pipeline. adoptElement remembers the exact slot the element came
// from; releaseElement puts it back there.

export function adoptElement(element, parentEl) {
  if (!element || !parentEl || element.parentElement === parentEl) return;
  if (!element._adoptHome) {
    element._adoptHome = { parent: element.parentElement, next: element.nextElementSibling };
  }
  parentEl.appendChild(element);
}

// Put an adopted element back where it came from. `fallbackParent` catches the case where the original
// parent was removed from the document while the element was away (a rebuilt session card), so the
// element is never left orphaned inside a surface that is about to be hidden.
export function releaseElement(element, fallbackParent = null) {
  const home = element?._adoptHome;
  if (!home) return;
  delete element._adoptHome;
  if (!home.parent?.isConnected) {
    if (fallbackParent) fallbackParent.appendChild(element);
    return;
  }
  if (home.next && home.next.parentElement === home.parent) {
    home.parent.insertBefore(element, home.next);
    return;
  }
  home.parent.appendChild(element);
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
