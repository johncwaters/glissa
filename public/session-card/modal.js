// Shared modal overlay scaffold: overlay/backdrop creation, Escape-to-close (hoisted handler,
// removed on close), backdrop-click-to-close, and close() teardown (remove overlay, refocus the
// opener). Lives in session-card/ rather than dialogs.js so card-dom.js can use it too without a
// dialogs.js <-> card-dom.js cycle (see the header note in card-dom.js).

import { el } from '../dom-helpers.ts';

export function createModalOverlay({ dialogClass = 'dialog', closeOnBackdrop = true } = {}) {
  const opener = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = dialogClass;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    close();
  }
  document.addEventListener('keydown', onKeydown);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    if (opener instanceof HTMLElement) opener.focus();
  }

  if (closeOnBackdrop) {
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return;
      close();
    });
  }

  return { overlay, dialog, close };
}

// The dialog role + focus trap every overlay applies once its labelling title exists.
export function applyDialogAria(dialog, titleId) {
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  trapFocus(dialog);
}

// Overlay plus the chrome every hand-built dialog repeats: a labelled title, an actions row, and the
// cancel button that closes it. The caller appends its own body between the two.
/** @param {{ title: string, dialogClass?: string, cancelLabel?: string }} options */
export function buildDialogShell({ title, dialogClass = 'dialog', cancelLabel = 'Cancel' }) {
  const { overlay, dialog, close } = createModalOverlay({ dialogClass });
  const titleId = `dialog-title-${Math.random().toString(36).slice(2)}`;

  const titleEl = el('h3', 'dialog-title', title);
  titleEl.id = titleId;
  const actions = el('div', 'dialog-actions');
  const btnCancel = el('button', 'btn-dialog btn-dialog-cancel', cancelLabel);
  actions.append(btnCancel);

  dialog.append(titleEl);
  applyDialogAria(dialog, titleId);

  return { overlay, dialog, close, titleEl, actions, btnCancel };
}

// The confirm prompt every destructive action goes through. It lives here, beside the overlay
// scaffold, because both dialogs.js and card-dom.js need it and card-dom.js may not import
// dialogs.js (see the header note there); each used to carry its own copy of this builder.
export function openConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }) {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title });

  const msgEl = el('p', 'dialog-message', message);

  const btnConfirm = el('button', danger ? 'btn-dialog btn-dialog-confirm btn-dialog-danger' : 'btn-dialog btn-dialog-confirm', confirmLabel);

  actions.append(btnConfirm);
  dialog.append(msgEl, actions);

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', () => { close(); onConfirm?.(); });

  requestAnimationFrame(() => btnCancel.focus());
}

// Tab-key focus trap: keeps keyboard focus cycling within the dialog's focusable elements instead
// of escaping to the page behind the overlay. Reached through applyDialogAria, which every dialog on
// this scaffold calls.
function trapFocus(dialog) {
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); return; }
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
