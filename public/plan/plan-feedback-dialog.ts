import { el } from '../dom-helpers.ts';
import { buildDialogShell } from '../session-card/modal.ts';
import type { PlanCommentRequest } from './plan-face.ts';

export function openPlanFeedbackDialog({ title, value, maxChars }: PlanCommentRequest, onSubmit: (text: string) => void) {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title });

  const field = el('textarea', 'dialog-input plan-feedback-input');
  field.rows = 8;
  field.maxLength = maxChars;
  field.placeholder = 'What should change?';
  field.value = value;
  field.setAttribute('aria-label', title);

  const btnSend = el('button', 'btn-dialog btn-dialog-confirm', 'Save');
  actions.append(btnSend);
  dialog.append(field, actions);

  btnCancel.addEventListener('click', close);
  btnSend.addEventListener('click', () => {
    const text = field.value;
    close();
    onSubmit(text);
  });

  field.focus();
}
