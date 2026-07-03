// ── Recent runs ───────────────────────────────────────────────

import { sendControlMsg } from '../control-ws.js';
import { el } from '../dom-helpers.js';
import { artifactLabel, classifyVerdict, formatRunDate, labelFor, VERDICT_GLYPH } from './format-core.mjs';

function artifactButtons(refs, r) {
  const detail = refs.team.stageDetail || [];
  const avail = (r.reached || []).map((id) => detail.find((s) => s.id === id)).filter((s) => s?.produces);
  if (!avail.length && !r.chat) return null;
  const wrap = el('div', 'run-artifacts');
  wrap.append(el('span', 'run-artifacts-label', 'Open'));
  for (const s of avail) {
    const b = el('button', 'run-artifact', artifactLabel(s.produces));
    b.type = 'button';
    b.addEventListener('click', () => {
      sendControlMsg({ type: 'open-artifact', teamId: refs.teamId, projectId: refs.projectId, runId: r.runId, artifact: s.produces });
    });
    wrap.append(b);
  }
  // The operator conversation transcript, when this run recorded one.
  if (r.chat) {
    const b = el('button', 'run-artifact', 'Conversation');
    b.type = 'button';
    b.addEventListener('click', () => {
      sendControlMsg({ type: 'open-artifact', teamId: refs.teamId, projectId: refs.projectId, runId: r.runId, artifact: 'chat.md' });
    });
    wrap.append(b);
  }
  return wrap;
}

function renderRunRow(refs, r) {
  const hasVerdict = !!r.verdict;
  const kind = hasVerdict ? classifyVerdict(r.verdict) : 'incomplete';
  const li = el('li', 'run-item');
  li.dataset.verdict = kind;

  const row = el('button', 'run-row');
  row.type = 'button';
  row.setAttribute('aria-expanded', 'false');
  const verdict = el('span', 'run-verdict', hasVerdict ? `${VERDICT_GLYPH[kind] || ''} ${r.verdict}`.trim() : 'Incomplete');
  verdict.dataset.verdict = kind;
  const topic = el('span', 'run-topic', r.topic || '(no topic recorded)');
  if (r.topic) topic.title = r.topic;
  const date = el('span', 'run-date', formatRunDate(r.runId));
  const chevron = el('span', 'run-chevron', '▸');
  chevron.setAttribute('aria-hidden', 'true');
  row.append(verdict, topic, date, chevron);

  const detail = el('div', 'run-detail');
  detail.hidden = true;
  if (r.summary) detail.append(el('p', 'run-summary', r.summary));
  if (r.platforms) detail.append(el('p', 'run-platforms', `Platforms: ${r.platforms}`));
  if (r.reached?.length) {
    detail.append(el('p', 'run-reached', `Ran: ${r.reached.map(labelFor).join(' → ')}`));
  }
  const arts = artifactButtons(refs, r);
  detail.append(arts || el('p', 'run-noartifacts', 'No files were written for this run.'));

  row.addEventListener('click', () => {
    const open = detail.hidden;
    detail.hidden = !open;
    row.setAttribute('aria-expanded', String(open));
    li.classList.toggle('open', open);
  });

  li.append(row, detail);
  return li;
}

export function renderRuns(refs, runs) {
  if (!runs || runs.length === 0) {
    refs.runsList.replaceChildren(el('li', 'run-item run-empty', 'No runs yet.'));
    return;
  }
  refs.runsList.replaceChildren(...runs.map((r) => renderRunRow(refs, r)));
}
