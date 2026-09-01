// ── DOM helpers ──────────────────────────────────────────────
// Shared utility for creating DOM elements.

import type { SessionState } from '#shared/states.ts';
import { BADGE_LABELS, STATE_GLYPHS } from '#shared/states.ts';

export type AdoptableElement = HTMLElement & { _adoptHome?: { parent: HTMLElement | null; next: Element | null } };

export function el<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string | null,
  text?: string | null
): HTMLElementTagNameMap[Tag] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// querySelector answers Element, which carries none of the properties these lookups exist to reach.
// The instanceof gate both narrows the type and turns a selector that no longer matches the markup into
// a throw at wiring time, where it names itself, instead of an undefined read somewhere downstream.

export function queryTag<Tag extends keyof HTMLElementTagNameMap>(
  root: ParentNode,
  selector: string,
  tag: Tag
): HTMLElementTagNameMap[Tag] {
  const found = root.querySelector(selector);
  if (!found || found.tagName.toLowerCase() !== tag) throw new Error(`${selector} does not match a <${tag}>`);
  return found as HTMLElementTagNameMap[Tag];
}

export function query(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`${selector} matches no element`);
  return found;
}

// A link when there is somewhere to go, otherwise the same text as a plain span.
export function externalLink(className: string, text: string, url: string | null | undefined, title: string = text): HTMLElement {
  if (!url) {
    const plain = el('span', className, text);
    plain.title = title;
    return plain;
  }
  const link = el('a', className, text);
  link.title = title;
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

// ── State display ────────────────────────────────────────────
// Here rather than in focus-view/attention-core.mjs: that core is dynamic-imported by a node test and
// must stay free of the bundler-only /shared alias.

export const MERGE_TAGS: Readonly<Record<string, string>> = { 'pending-review': 'REVIEW', parked: 'PARKED', merging: 'MERGING' };

export function stateChip(state: string) {
  const knownState = state as SessionState;
  return { glyph: STATE_GLYPHS[knownState] || '', label: (BADGE_LABELS[knownState] || state).toUpperCase() };
}

// ── Header height token ──────────────────────────────────────
// --header-h anchors the notice region below whichever top bar is rendered; a bar measuring zero is the
// hidden one, and writing its height would drop every toast on top of the bar that IS on screen.

export function observeHeaderHeight(barEl: HTMLElement | null | undefined) {
  if (!barEl) return;
  let pendingRaf: number | null = null;
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

export function buildPanelSection(prefix: string, title: string | null | undefined, hint?: string | null) {
  const section = el('section', `${prefix}-section`);
  const head = el('div', `${prefix}-section-head`);
  head.append(el('h2', `${prefix}-section-title`, title));
  if (hint) head.append(el('span', `${prefix}-section-hint`, hint));
  section.append(head);
  return section;
}

export function buildStatChip(prefix: string, label: string, value: string, tone?: string | null) {
  const wrap = el('span', `${prefix}-stat`);
  if (tone) wrap.dataset.tone = tone;
  wrap.append(el('span', `${prefix}-stat-value`, value), el('span', `${prefix}-stat-label`, label));
  return wrap;
}

// A panel's projects array, or an empty one. The poller broadcasts arrive before any lane is
// configured, so every panel guards this the same way.
export function projectsOf<Project = Record<string, unknown>>(snapshot: { projects?: unknown } | null | undefined): Project[] {
  return Array.isArray(snapshot?.projects) ? (snapshot.projects as Project[]) : [];
}

// Whether a mounted panel is inside a hidden tabpanel or phone screen. Panels are mounted eagerly (a
// broadcast must be able to raise a tab dot from anywhere), so each one asks this before repainting.
export function isPanelHidden(root: Element | null | undefined) {
  return !root || !!root.closest('[hidden]');
}

// Returns the write promise, or null when the Clipboard API is absent
// (insecure context): callers decide whether silence or a toast fits.
export function writeClipboardText(text: string) {
  if (!navigator.clipboard?.writeText) return null;
  return navigator.clipboard.writeText(text);
}

// ── Adoption (move an element, never copy it) ────────────────
// Some elements carry live state that cannot be rebuilt: a session card owns an xterm, the review
// sidebar owns its diff caches and listeners, the header menu owns its wiring. When the phone layout
// wants one of those, it MOVES the original and gives it back afterwards rather than building a second
// copy that would then need its own pipeline. adoptElement remembers the exact slot the element came
// from; releaseElement puts it back there.

export function adoptElement(element: AdoptableElement | null | undefined, parentEl: HTMLElement | null | undefined) {
  if (!element || !parentEl || element.parentElement === parentEl) return;
  if (!element._adoptHome) {
    element._adoptHome = { parent: element.parentElement, next: element.nextElementSibling };
  }
  parentEl.appendChild(element);
}

// Put an adopted element back where it came from. `fallbackParent` catches the case where the original
// parent was removed from the document while the element was away (a rebuilt session card), so the
// element is never left orphaned inside a surface that is about to be hidden.
export function releaseElement(element: AdoptableElement | null | undefined, fallbackParent: ParentNode | null = null) {
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

export function escapeHtml(str: unknown) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
