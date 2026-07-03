// Pull a single instance's full state in one request: runs, active flag, schedule + next fire, and
// (while a run is active) the conversation transcript.

import { sendControlRequest } from '../control-ws.js';
import { el } from '../dom-helpers.js';
import { appendChatMsg, clearChatAwaiting, setChatAwaiting } from './chat.js';
import { formatNextFire, key, scheduleSummary } from './format-core.mjs';
import { notifyTabActivity, runningKeys } from './registry.js';
import { rehydrateLive } from './run-status.js';
import { renderRuns } from './runs-list.js';
import { renderSetup } from './setup-banner.js';

export function applyScheduleSummary(refs, nextFire) {
  const sch = refs.schedule;
  const hasDays = sch?.days?.length;
  if (refs.enabled && hasDays) {
    refs.schedSummary.textContent = scheduleSummary(sch);
    refs.next.hidden = !nextFire;
    if (nextFire) refs.next.textContent = `Next run ${formatNextFire(nextFire)}`;
    return;
  }
  refs.schedSummary.textContent = hasDays ? `${scheduleSummary(sch)} · off` : 'Manual only';
  refs.next.hidden = true;
}

export function refreshInstance(refs) {
  refs.runsList.replaceChildren(el('li', 'run-item run-empty', 'Loading...'));
  sendControlRequest('get-team-pack-status', { teamId: refs.teamId, projectId: refs.projectId })
    .then((ps) => renderSetup(refs, ps))
    .catch(() => {});
  sendControlRequest('get-team-runs', { teamId: refs.teamId, projectId: refs.projectId })
    .then((msg) => {
      if (msg.schedule) refs.schedule = msg.schedule;
      refs.enabled = !!msg.enabled;
      if (!refs.running) refs.schedCb.checked = refs.enabled;
      applyScheduleSummary(refs, msg.nextFire);
      renderRuns(refs, msg.runs || []);
      if (msg.active && !refs.running) {
        rehydrateLive(refs, msg.live);
        runningKeys.add(key(refs.teamId, refs.projectId));
        notifyTabActivity();
      }
      // Rehydrate the conversation only while a run is active (so a completion refresh never wipes the
      // just-finished live transcript already in the DOM).
      if (msg.active) {
        sendControlRequest('get-team-chat', { teamId: refs.teamId, projectId: refs.projectId })
          .then((c) => {
            refs.chatLog.replaceChildren();
            for (const m of (c.messages || [])) appendChatMsg(refs, m);
            if (c.awaiting) { setChatAwaiting(refs, c.pendingQuestion); return; }
            clearChatAwaiting(refs);
          })
          .catch(() => {});
      }
    })
    .catch(() => { refs.runsList.replaceChildren(el('li', 'run-item run-empty', 'Could not load run history.')); });
}
