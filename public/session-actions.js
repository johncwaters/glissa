import { sendControlMsg } from './control-ws.js';
import { sessionUIs } from './session-card/card-registry.js';
import { openConfirmDialog } from './session-card/modal.js';
import { suggestSessionName } from './session-card/naming.js';

export function quickAddSession(path, label) {
  if (!path) return;
  sendControlMsg({ type: 'add-session', name: suggestSessionName(label), path });
}

export function requestSessionRemoval(id, mergeStatus) {
  const ui = sessionUIs.get(id);
  if (!ui) return;
  const currentMergeStatus = mergeStatus || ui.card?.dataset.merge || 'none';
  const hasUnmergedWork = currentMergeStatus === 'pending-review' || currentMergeStatus === 'parked';
  if (!hasUnmergedWork) {
    sendControlMsg({ type: 'remove-session', id });
    return;
  }
  const sessionName = ui.card?.dataset.session || ui.nameEl?.textContent || '';
  openConfirmDialog({
    title: 'Remove Session',
    message: `"${sessionName}" has unmerged worktree changes that will be permanently discarded if you remove it. Merge or review them first to keep them. Remove anyway?`,
    confirmLabel: 'Discard & Remove',
    onConfirm: () => sendControlMsg({ type: 'remove-session', id }),
  });
}
