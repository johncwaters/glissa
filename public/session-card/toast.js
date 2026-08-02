// Error notices, stacked top-right so they never overlap the terminals or the
// bottom dock. Leaf module: depends only on the DOM-element helper, so any
// session-card module can import it without creating an import cycle.

import { el } from '../dom-helpers.js';

// Transient notices clear themselves; persistent ones (real failures) wait for
// the operator to dismiss them.
const AUTO_DISMISS_MS = 6000;
// Safety net if `transitionend` never fires (e.g. element detached mid-exit).
const EXIT_FALLBACK_MS = 400;
const CLOSE_GLYPH = String.fromCharCode(0x00d7); // multiplication sign as an x

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
  if (notice._dismissed) return;
  notice._dismissed = true;
  if (notice._timer) clearTimeout(notice._timer);
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
  if (newest && newest._message === message && !newest._dismissed) {
    newest._count = (newest._count || 1) + 1;
    const counter = newest.querySelector('.notice-count');
    counter.textContent = `x${newest._count}`;
    counter.hidden = false;
    if (!persist && newest._timer) {
      clearTimeout(newest._timer);
      newest._timer = setTimeout(() => dismiss(newest), AUTO_DISMISS_MS);
    }
    return newest;
  }

  const notice = el('div', persist ? 'notice is-persistent' : 'notice');
  notice._message = message;
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
    notice._timer = setTimeout(() => dismiss(notice), AUTO_DISMISS_MS);
  }

  return notice;
}
