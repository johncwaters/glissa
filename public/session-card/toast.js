// Error notices, stacked top-right so they never overlap the terminals or the
// bottom dock. Leaf module: depends only on the DOM-element helper, so any
// session-card module can import it without creating an import cycle.

import { el, queryTag } from '../dom-helpers.js';

// Transient notices clear themselves; persistent ones (real failures) wait for
// the operator to dismiss them.
const AUTO_DISMISS_MS = 6000;
// Safety net if `transitionend` never fires (e.g. element detached mid-exit).
const EXIT_FALLBACK_MS = 400;
const CLOSE_GLYPH = String.fromCharCode(0x00d7); // multiplication sign as an x

/** @typedef {{ message: string, count: number, timer: ReturnType<typeof setTimeout> | null, dismissed: boolean }} ToastState */

/** @type {WeakMap<Element, ToastState>} */
const toastState = new WeakMap();

function ensureRegion() {
  let region = document.getElementById('notice-region');
  if (!region) {
    region = el('div', 'notice-region');
    region.id = 'notice-region';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(region);
  }
  return region;
}

function dismiss(notice) {
  const state = toastState.get(notice);
  if (!state || state.dismissed) return;
  state.dismissed = true;
  if (state.timer) clearTimeout(state.timer);
  notice.classList.add('is-leaving');
  notice.addEventListener('transitionend', () => notice.remove(), { once: true });
  setTimeout(() => notice.remove(), EXIT_FALLBACK_MS);
}

// showErrorToast(message, { persist }) - persist:true keeps the notice until the
// operator dismisses it (default false = auto-dismiss). Identical back-to-back
// messages collapse into a single notice with an xN counter.
export function showErrorToast(message, opts = {}) {
  const persist = opts.persist === true;
  const region = ensureRegion();

  const newest = region.firstElementChild;
  const newestState = newest ? toastState.get(newest) : null;
  if (newestState && newestState.message === message && !newestState.dismissed) {
    newestState.count++;
    const counter = queryTag(newest, '.notice-count', 'span');
    counter.textContent = `x${newestState.count}`;
    counter.hidden = false;
    if (!persist && newestState.timer) {
      clearTimeout(newestState.timer);
      newestState.timer = setTimeout(() => dismiss(newest), AUTO_DISMISS_MS);
    }
    return newest;
  }

  const notice = el('div', persist ? 'notice is-persistent' : 'notice');
  /** @type {ToastState} */
  const state = { message, count: 1, timer: null, dismissed: false };
  toastState.set(notice, state);
  notice.setAttribute('role', 'alert');

  const glyph = el('span', 'notice-glyph', '!');
  glyph.setAttribute('aria-hidden', 'true');

  const body = el('span', 'notice-msg', message);

  const counter = el('span', 'notice-count');
  counter.hidden = true;

  const close = el('button', 'notice-close', CLOSE_GLYPH);
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.addEventListener('click', () => dismiss(notice));

  notice.append(glyph, body, counter, close);
  region.prepend(notice); // newest on top

  // Animate in on the next frame so the entry transition runs.
  requestAnimationFrame(() => notice.classList.add('is-visible'));

  if (!persist) {
    state.timer = setTimeout(() => dismiss(notice), AUTO_DISMISS_MS);
  }

  return notice;
}
