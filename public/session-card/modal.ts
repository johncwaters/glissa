import { el } from '../dom-helpers.ts';

export function createModalOverlay({ dialogClass = 'dialog', closeOnBackdrop = true } = {}) {
  const opener = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = dialogClass;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  function onKeydown(e: KeyboardEvent) {
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

export function applyDialogAria(dialog: HTMLElement, titleId: string) {
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  trapFocus(dialog);
}

export function buildDialogShell({ title, dialogClass = 'dialog', cancelLabel = 'Cancel' }: {
  title: string;
  dialogClass?: string;
  cancelLabel?: string;
}) {
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

export function openConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm?: () => void;
}) {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title });

  const msgEl = el('p', 'dialog-message', message);

  const btnConfirm = el('button', danger ? 'btn-dialog btn-dialog-confirm btn-dialog-danger' : 'btn-dialog btn-dialog-confirm', confirmLabel);

  actions.append(btnConfirm);
  dialog.append(msgEl, actions);

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', () => { close(); onConfirm?.(); });

  requestAnimationFrame(() => btnCancel.focus());
}

function trapFocus(dialog: HTMLElement) {
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); return; }
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
