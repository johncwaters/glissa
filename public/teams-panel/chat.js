// ── Conversation pane ─────────────────────────────────────────
// A small, non-terminal chat surface per instance: a live feed (lifecycle system lines + the agents'
// questions) plus an input the operator uses to steer between stages or answer a paused stage's
// question.

import { el } from '../dom-helpers.js';
import { chatRoleLabel, labelFor } from './format-core.mjs';

export function autosizeChat(field) {
  field.style.height = 'auto';
  field.style.height = `${Math.min(field.scrollHeight, 120)}px`;
}

// Append one message bubble. role operator|agent renders with a who/stage meta line; anything else
// renders as a terse system line (lifecycle narration). Auto-scrolls to the newest.
export function appendChatMsg(refs, m) {
  if (!refs || !refs.chatLog) return;
  const role = m.role === 'operator' ? 'operator' : (m.role === 'agent' ? 'agent' : 'system');
  const row = el('div', 'chat-msg');
  row.dataset.role = role;
  if (role !== 'system') {
    const who = chatRoleLabel(role);
    const meta = el('span', 'chat-msg-meta', m.stage ? `${who} · ${labelFor(m.stage)}` : who);
    row.append(meta);
  }
  row.append(el('div', 'chat-msg-text', String(m.text == null ? '' : m.text)));
  refs.chatLog.append(row);
  refs.chatLog.scrollTop = refs.chatLog.scrollHeight;
}

export function appendSystemLine(refs, text) {
  appendChatMsg(refs, { role: 'system', text });
}

export function setChatAwaiting(refs, question) {
  if (!refs) return;
  refs.chatAwaiting = true;
  if (refs.chatPending) {
    refs.chatPending.hidden = false;
    refs.chatPending.replaceChildren(
      el('span', 'chat-pending-label', 'Waiting on you'),
      el('span', 'chat-pending-text', question || 'The team asked a question.'),
    );
  }
  if (refs.chatSend) refs.chatSend.textContent = 'Answer';
  if (refs.chatField) {
    refs.chatField.classList.add('awaiting');
    requestAnimationFrame(() => refs.chatField.focus());
  }
}

export function clearChatAwaiting(refs) {
  if (!refs) return;
  refs.chatAwaiting = false;
  if (refs.chatPending) { refs.chatPending.hidden = true; refs.chatPending.replaceChildren(); }
  if (refs.chatSend) refs.chatSend.textContent = 'Send';
  if (refs.chatField) refs.chatField.classList.remove('awaiting');
}
