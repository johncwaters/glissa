// Transient error toast. Leaf module: depends only on the DOM-element helper, so
// any session-card module can import it without creating an import cycle.

import { el } from '../dom-helpers.js';

export function showErrorToast(message) {
  const toast = el('div', 'error-toast', message);
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('transitionend', () => toast.remove());
  }, 4000);
}
