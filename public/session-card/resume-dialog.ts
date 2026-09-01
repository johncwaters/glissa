import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el, escapeHtml } from '../dom-helpers.ts';
import { buildDialogShell } from './modal.ts';
import { showErrorToast } from './toast.ts';

const DORMANT = 'DORMANT';

function relTime(ms: number | null | undefined) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface ResumableConversation {
  id: string;
  title?: string;
  worktreeName?: string;
  gitBranch?: string;
  mtime?: number;
}

function buildItem(conv: ResumableConversation, currentId: string | null, onPick: (conversationId: string) => void) {
  const item = el('button', 'resume-item');
  item.type = 'button';
  item.setAttribute('role', 'option');
  if (conv.id === currentId) item.classList.add('resume-item-current');

  const meta = [conv.worktreeName, conv.gitBranch ? conv.gitBranch.replace(/^refs\/heads\//, '') : null, relTime(conv.mtime)]
    .filter(Boolean)
    .join(' · ');

  item.innerHTML =
    `<span class="resume-item-title">${escapeHtml(conv.title || conv.id)}</span>` +
    `<span class="resume-item-meta">${escapeHtml(meta)}${conv.id === currentId ? ' · current' : ''}</span>`;
  item.addEventListener('click', () => onPick(conv.id));
  return item;
}

export function openResumeDialog(sessionId: string, opts: { currentState?: string } = {}) {
  const isDormant = (opts.currentState || '') === DORMANT;

  const { overlay, dialog, close, actions, btnCancel } = buildDialogShell({
    title: 'Resume a conversation',
    dialogClass: 'dialog resume-dialog',
  });

  const hint = el('p', 'dialog-message', 'Pick a Claude conversation from this repo (any worktree) to continue in this card.');
  const listEl = el('div', 'resume-list');
  listEl.setAttribute('role', 'listbox');
  listEl.setAttribute('aria-label', 'Resumable conversations');
  listEl.append(el('div', 'resume-empty', 'Loading conversations...'));

  const btnClear = el('button', 'btn-dialog btn-dialog-cancel', 'Start fresh');
  btnClear.title = 'Clear any resume binding so this card starts a new conversation';
  actions.prepend(btnClear);

  dialog.append(hint, listEl, actions);

  function apply(conversationId: string | null) {
    sendControlMsg({ type: 'resume-conversation', id: sessionId, conversationId: conversationId || '' });
    close();
    if (!conversationId) return;
    if (!isDormant) {
      showErrorToast("Conversation will resume on this session's next restart.");
      return;
    }
    sendControlMsg({ type: 'start-session', id: sessionId });
  }

  btnCancel.addEventListener('click', close);
  btnClear.addEventListener('click', () => apply(null));
  requestAnimationFrame(() => btnCancel.focus());

  sendControlRequest('list-conversations', { id: sessionId })
    .then((res) => {
      if (!overlay.isConnected) return;
      const convs = Array.isArray(res.conversations) ? (res.conversations as ResumableConversation[]) : [];
      listEl.innerHTML = '';
      if (res.error) {
        listEl.append(el('div', 'resume-empty', `Could not list conversations: ${res.error}`));
        return;
      }
      if (convs.length === 0) {
        listEl.append(el('div', 'resume-empty', 'No prior conversations found for this repo.'));
        return;
      }
      const currentId = typeof res.current === 'string' ? res.current : null;
      for (const conv of convs) listEl.append(buildItem(conv, currentId, apply));
    })
    .catch((err) => {
      if (!overlay.isConnected) return;
      listEl.innerHTML = '';
      const reason = err instanceof Error ? err.message : String(err);
      listEl.append(el('div', 'resume-empty', `Could not list conversations: ${reason}`));
    });
}
