import { el, queryTag } from '../dom-helpers.ts';

const AUTO_DISMISS_MS = 6000;

const EXIT_FALLBACK_MS = 400;
const CLOSE_GLYPH = String.fromCharCode(0x00d7);

interface ToastState {
  message: string;
  count: number;
  timer: ReturnType<typeof setTimeout> | null;
  dismissed: boolean;
}

const toastState = new WeakMap<Element, ToastState>();

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

function dismiss(notice: Element) {
  const state = toastState.get(notice);
  if (!state || state.dismissed) return;
  state.dismissed = true;
  if (state.timer) clearTimeout(state.timer);
  notice.classList.add('is-leaving');
  notice.addEventListener('transitionend', () => notice.remove(), { once: true });
  setTimeout(() => notice.remove(), EXIT_FALLBACK_MS);
}

export function showErrorToast(rawMessage: unknown, opts: { persist?: boolean } = {}) {
  const message = typeof rawMessage === 'string' ? rawMessage : String(rawMessage);
  const persist = opts.persist === true;
  const region = ensureRegion();

  const newest = region.firstElementChild;
  const newestState = newest ? toastState.get(newest) : null;
  if (newestState && newestState.message === message && !newestState.dismissed) {
    if (!newest) throw new Error('Toast state exists without a notice element');
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
  const state: ToastState = { message, count: 1, timer: null, dismissed: false };
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
  region.prepend(notice);

  requestAnimationFrame(() => notice.classList.add('is-visible'));

  if (!persist) {
    state.timer = setTimeout(() => dismiss(notice), AUTO_DISMISS_MS);
  }

  return notice;
}
