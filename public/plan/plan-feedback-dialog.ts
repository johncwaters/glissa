import { PLAN_FEEDBACK_MAX_CHARS } from '#shared/contracts/plan-review.ts';
import { el } from '../dom-helpers.ts';
import { buildDialogShell } from '../session-card/modal.ts';

export function openPlanFeedbackDialog(onSubmit: (feedback: string) => void) {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Send feedback' });

  const field = el('textarea', 'dialog-input plan-feedback-input');
  field.rows = 8;
  field.maxLength = PLAN_FEEDBACK_MAX_CHARS;
  field.placeholder = 'What should change in this plan?';
  field.setAttribute('aria-label', 'Feedback on this plan');

  const btnSend = el('button', 'btn-dialog btn-dialog-confirm', 'Send feedback');
  actions.append(btnSend);
  dialog.append(field, actions);

  btnCancel.addEventListener('click', close);
  btnSend.addEventListener('click', () => {
    const feedback = field.value;
    close();
    onSubmit(feedback);
  });

  field.focus();
}
