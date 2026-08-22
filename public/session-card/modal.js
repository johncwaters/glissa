// Shared modal overlay scaffold: overlay/backdrop creation, Escape-to-close (hoisted handler,
// removed on close), backdrop-click-to-close, and close() teardown (remove overlay, refocus the
// opener). Lives in session-card/ rather than dialogs.js so card-dom.js can use it too without a
// dialogs.js <-> card-dom.js cycle (see the header note in card-dom.js).

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
    opener?.focus?.();
  }

  if (closeOnBackdrop) {
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return;
      close();
    });
  }

  return { overlay, dialog, close };
}

// The confirm prompt every destructive action goes through. It lives here, beside the overlay
// scaffold, because both dialogs.js and card-dom.js need it and card-dom.js may not import
// dialogs.js (see the header note there); each used to carry its own copy of this builder.
export function openConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }) {
  const { dialog, close } = createModalOverlay();

  const titleId = `confirm-dialog-title-${Math.random().toString(36).slice(2)}`;

  const titleEl = document.createElement('h3');
  titleEl.id = titleId;
  titleEl.className = 'dialog-title';
  titleEl.textContent = title;

  const msgEl = document.createElement('p');
  msgEl.className = 'dialog-message';
  msgEl.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'btn-dialog btn-dialog-cancel';
  btnCancel.textContent = 'Cancel';

  const btnConfirm = document.createElement('button');
  btnConfirm.className = danger ? 'btn-dialog btn-dialog-confirm btn-dialog-danger' : 'btn-dialog btn-dialog-confirm';
  btnConfirm.textContent = confirmLabel;

  actions.append(btnCancel, btnConfirm);
  dialog.append(titleEl, msgEl, actions);

  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  trapFocus(dialog);

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', () => { close(); onConfirm?.(); });

  requestAnimationFrame(() => btnCancel.focus());
}

// Tab-key focus trap: keeps keyboard focus cycling within the dialog's focusable elements instead
// of escaping to the page behind the overlay. Shared by every dialog built on createModalOverlay.
export function trapFocus(dialog) {
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
