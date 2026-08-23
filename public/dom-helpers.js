// ── DOM helpers ──────────────────────────────────────────────
// Shared utility for creating DOM elements.

import { BADGE_LABELS, STATE_GLYPHS } from '/shared/states.mjs';

export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// A link when there is somewhere to go, otherwise the same text as a plain span.
export function externalLink(className, text, url, title = text) {
  const node = url ? el('a', className, text) : el('span', className, text);
  node.title = title;
  if (!url) return node;
  node.href = url;
  node.target = '_blank';
  node.rel = 'noopener';
  return node;
}

// ── State display ────────────────────────────────────────────
// Here rather than in focus-view/attention-core.mjs: that core is dynamic-imported by a node test and
// must stay free of the bundler-only /shared alias.

export const MERGE_TAGS = { 'pending-review': 'REVIEW', parked: 'PARKED', merging: 'MERGING' };

export function stateChip(state) {
  return { glyph: STATE_GLYPHS[state] || '', label: (BADGE_LABELS[state] || state).toUpperCase() };
}

// ── Header height token ──────────────────────────────────────
// --header-h anchors the notice region below whichever top bar is rendered; a bar measuring zero is the
// hidden one, and writing its height would drop every toast on top of the bar that IS on screen.

export function observeHeaderHeight(barEl) {
  if (!barEl) return;
  let pendingRaf = null;
  const syncHeaderHeight = () => {
    pendingRaf = null;
    const height = barEl.offsetHeight;
    if (height > 0) document.documentElement.style.setProperty('--header-h', `${height}px`);
  };
  new ResizeObserver(() => {
    if (pendingRaf !== null) return;
    pendingRaf = requestAnimationFrame(syncHeaderHeight);
  }).observe(barEl);
}

// ── Panel chrome ─────────────────────────────────────────────
// The five tab panels (Radar, PRs, Usage, Mill, Visions) share a section head and a summary stat chip that
// differ only in their class prefix, and each used to carry its own copy. `prefix` names the panel so
// the existing per-panel CSS is unchanged.

export function buildPanelSection(prefix, title, hint) {
  const section = el('section', `${prefix}-section`);
  const head = el('div', `${prefix}-section-head`);
  head.append(el('h2', `${prefix}-section-title`, title));
  if (hint) head.append(el('span', `${prefix}-section-hint`, hint));
  section.append(head);
  return section;
}

export function buildStatChip(prefix, label, value, tone) {
  const wrap = el('span', `${prefix}-stat`);
  if (tone) wrap.dataset.tone = tone;
  wrap.append(el('span', `${prefix}-stat-value`, value), el('span', `${prefix}-stat-label`, label));
  return wrap;
}

// A panel's projects array, or an empty one. The poller broadcasts arrive before any lane is
// configured, so every panel guards this the same way.
export function projectsOf(snapshot) {
  return Array.isArray(snapshot?.projects) ? snapshot.projects : [];
}

// Whether a mounted panel is inside a hidden tabpanel or phone screen. Panels are mounted eagerly (a
// broadcast must be able to raise a tab dot from anywhere), so each one asks this before repainting.
export function isPanelHidden(root) {
  return !root || !!root.closest('[hidden]');
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
