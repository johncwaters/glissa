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
