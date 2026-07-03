// (Re)renders the Teams view stack and handles server broadcasts. This is the top-level orchestrator
// mirroring session-card/lifecycle.js: it owns create/remove/mount and dispatches every team-*
// message to the right per-instance update.

import { sendControlRequest } from '../control-ws.js';
import { el } from '../dom-helpers.js';
import { buildAddBar, populateProjectOptions, populateRosterOptions, wireAddBar } from './add-bar.js';
import { appendChatMsg, appendSystemLine, clearChatAwaiting, setChatAwaiting } from './chat.js';
import { failText, key, labelFor, mergeNote } from './format-core.mjs';
import { renderInstancePanel } from './instance-panel.js';
import { refreshInstance } from './instance-refresh.js';
import { markStage, nextStageId, resetPipeline, settleActive, stageIndexLabel } from './pipeline.js';
import { mounted, notifyTabActivity, runningKeys, setMounted, setTabActivityCallback } from './registry.js';
import { setRunning, setStatus, startStageClock } from './run-status.js';
import { renderSetup } from './setup-banner.js';

export { setTabActivityCallback };
export { refreshTeamsProjects } from './add-bar.js';

function buildEmptyState() {
  const box = el('div', 'teams-empty-state');
  box.append(el('p', 'teams-empty-title', 'No team instances yet'));
  box.append(el('p', 'teams-empty-desc', 'A team is a premade roster (like the Marketing Pipeline) pointed at one of your projects. Add one above to run it on demand or on a schedule.'));
  return box;
}

function renderStack() {
  const stack = mounted.stackEl;
  for (const refs of mounted.instances.values()) if (refs.timer) clearInterval(refs.timer);
  mounted.instances.clear();

  if (!mounted.teams.size) {
    stack.replaceChildren(el('p', 'teams-empty', 'No teams defined under teams/.'));
    return;
  }
  const instances = (mounted.activations || []).filter((a) => mounted.teams.has(a.teamId));
  if (!instances.length) {
    stack.replaceChildren(buildEmptyState());
    return;
  }
  const panels = instances.map((a) => renderInstancePanel(mounted.teams.get(a.teamId), a));
  stack.replaceChildren(...panels);
  for (const a of instances) {
    const refs = mounted.instances.get(key(a.teamId, a.projectId));
    if (refs) refreshInstance(refs);
  }
}

function addInstancePanel(team, activation) {
  const k = key(team.id, activation.projectId);
  if (mounted.instances.has(k)) return;
  if (!mounted.instances.size) mounted.stackEl.replaceChildren(); // clear the empty state
  mounted.stackEl.append(renderInstancePanel(team, activation));
  const refs = mounted.instances.get(k);
  if (refs) refreshInstance(refs);
}

function removeInstancePanel(k) {
  const refs = mounted.instances.get(k);
  if (!refs) return;
  if (refs.timer) clearInterval(refs.timer);
  refs.panel.remove();
  mounted.instances.delete(k);
  runningKeys.delete(k);
  notifyTabActivity();
  if (!mounted.instances.size) mounted.stackEl.replaceChildren(buildEmptyState());
}

// (Re)render the whole view into `container`. `projects` is [{ id, name }].
export function mountTeamsView(container, projects = []) {
  if (mounted) {
    for (const refs of mounted.instances.values()) if (refs.timer) clearInterval(refs.timer);
  }
  runningKeys.clear();
  setMounted({ container, stackEl: null, addBar: null, teams: new Map(), instances: new Map(), projects, activations: [] });

  const intro = el('p', 'teams-intro', 'Premade agent pipelines. Bind a roster to a project, run it on demand or on a schedule, then open what each run produced. Each team reads its specifics from the project’s pack: the voice, brand, and channels you fill in once.');
  const add = buildAddBar();
  mounted.addBar = add;
  const stack = el('div', 'teams-stack');
  mounted.stackEl = stack;
  stack.append(el('p', 'teams-loading', 'Loading teams...'));
  // A config surface reads as a centered column, not a full-bleed wall; the view stays the
  // full-width scroll container so the scrollbar sits at the viewport edge, not mid-screen.
  const content = el('div', 'teams-content');
  content.append(intro, add.bar, stack);
  container.replaceChildren(content);
  wireAddBar(add);

  sendControlRequest('list-teams', {})
    .then((msg) => {
      mounted.teams = new Map((msg.teams || []).map((t) => [t.id, t]));
      mounted.activations = msg.activations || [];
      populateRosterOptions(add.rosterSel);
      populateProjectOptions(add.projSel);
      renderStack();
    })
    .catch(() => { stack.replaceChildren(el('p', 'teams-empty', 'Failed to load teams.')); });
}

// ── broadcast handling ────────────────────────────────────────

function onInstanceAdded(msg) {
  if (!mounted) return;
  mounted.activations = msg.activations || mounted.activations;
  if (mounted.addBar) {
    mounted.addBar.form.hidden = true;
    mounted.addBar.toggle.setAttribute('aria-expanded', 'false');
  }
  const team = mounted.teams.get(msg.teamId);
  if (!team) return;
  const activation = (mounted.activations || []).find((a) => a.teamId === msg.teamId && a.projectId === msg.projectId)
    || { teamId: msg.teamId, projectId: msg.projectId };
  addInstancePanel(team, activation);
}

function onInstanceRemoved(msg) {
  if (!mounted) return;
  mounted.activations = msg.activations || mounted.activations;
  removeInstancePanel(key(msg.teamId, msg.projectId));
}

// Called by app.js for team-* broadcasts: structural changes, the tab activity dot, the live
// pipeline, the running indicator + status, and a run-history refresh on completion.
export function handleTeamMessage(msg) {
  const { type, teamId, projectId } = msg;

  if (type === 'team-instance-added') { onInstanceAdded(msg); return; }
  if (type === 'team-instance-removed') { onInstanceRemoved(msg); return; }

  const k = key(teamId, projectId);
  if (type === 'team-run-accepted' || type === 'team-run-started' || type === 'team-stage-started') runningKeys.add(k);
  if (type === 'team-run-complete' || type === 'team-run-failed' || type === 'team-run-skipped' || type === 'team-run-needs-setup') runningKeys.delete(k);
  notifyTabActivity();

  if (!mounted) return;

  if (type === 'team-schedule-updated') {
    mounted.activations = msg.activations || mounted.activations;
    const r = mounted.instances.get(k);
    if (r) refreshInstance(r);
    return;
  }

  const refs = mounted.instances.get(k);
  if (!refs) return;

  switch (type) {
    case 'team-run-accepted':
      setRunning(refs, true);
      setStatus(refs, 'Accepted...', 'run');
      break;
    case 'team-run-started':
      setRunning(refs, true);
      resetPipeline(refs.stageNodes);
      refs.chatLog.replaceChildren(); // fresh run, fresh conversation
      clearChatAwaiting(refs);
      setStatus(refs, 'Running...', 'run');
      break;
    case 'team-stage-started': {
      setRunning(refs, true);
      markStage(refs.stageNodes, msg.stage, 'active');
      startStageClock(refs);
      // round > 0 means a FIX revision re-run: badge the stage with its revision number and say so.
      const node = refs.stageNodes.get(msg.stage);
      if (msg.round > 0) {
        if (node) node.dataset.round = String(msg.round);
        setStatus(refs, `${labelFor(msg.stage)} · revision ${msg.round}`, 'run');
        appendSystemLine(refs, `${labelFor(msg.stage)} revising (round ${msg.round})`);
        break;
      }
      setStatus(refs, `${labelFor(msg.stage)} · ${stageIndexLabel(refs, msg.stage)}`, 'run');
      appendSystemLine(refs, `${labelFor(msg.stage)} started`);
      break;
    }
    case 'team-revise-round':
      setStatus(refs, `Revising · round ${msg.round}`, 'run');
      break;
    case 'team-stage-complete': {
      markStage(refs.stageNodes, msg.stage, 'done');
      appendSystemLine(refs, `${labelFor(msg.stage)} finished${msg.verdict ? `: ${msg.verdict}` : ''}`);
      // Bridge the inter-stage gap: spawning the next `claude -p` can take many seconds, during which
      // the header would otherwise sit on the just-finished stage as if it were still active. Naming the
      // handoff keeps the run reading as live. A verdict stage (the editor) is left without a "next"
      // hint because a FIX re-runs an earlier stage instead - the team-revise-round / next
      // team-stage-started event resolves that within the same gap.
      const done = `${labelFor(msg.stage)} done${msg.verdict ? ` · ${msg.verdict}` : ''}`;
      const next = msg.verdict ? null : nextStageId(refs, msg.stage);
      setStatus(refs, next ? `${done} · starting ${labelFor(next)}...` : done, 'run');
      break;
    }
    case 'team-run-cancelling':
      setStatus(refs, 'Cancelling...', '');
      break;
    case 'team-run-complete': {
      settleActive(refs.stageNodes);
      setRunning(refs, false);
      const roundsNote = msg.rounds > 0 ? ` (${msg.rounds} round${msg.rounds > 1 ? 's' : ''})` : '';
      setStatus(refs, `Complete · ${msg.verdict || 'done'}${roundsNote}${mergeNote(msg)}`, 'ok');
      appendSystemLine(refs, `Run complete: ${msg.verdict || 'done'}${roundsNote}`);
      refreshInstance(refs);
      break;
    }
    case 'team-run-failed':
      if (msg.stage) markStage(refs.stageNodes, msg.stage, 'failed');
      setRunning(refs, false);
      setStatus(refs, failText(msg), 'fail');
      appendSystemLine(refs, failText(msg));
      refreshInstance(refs);
      break;
    case 'team-run-skipped':
      setRunning(refs, false);
      setStatus(refs, 'Skipped (already running)', '');
      break;
    case 'team-run-needs-setup': {
      setRunning(refs, false);
      const files = (msg.unfilled || []).join(', ');
      setStatus(refs, `Setup needed: fill the pack (${files || 'pack files'}) then run again`, 'fail');
      break;
    }
    case 'setup-team-pack-started':
      setStatus(refs, msg.already
        ? 'Setup already running, answer it in its session'
        : 'Setup started, answer the questions in its terminal session', 'run');
      break;
    case 'team-pack-updated': {
      renderSetup(refs, msg);
      if (msg.configured) { setStatus(refs, 'Pack ready, click Run', 'ok'); break; }
      const remaining = (msg.unfilled || []).join(', ');
      setStatus(refs, `Pack still needs: ${remaining || 'more input'}`, 'fail');
      break;
    }
    case 'team-chat-message':
      appendChatMsg(refs, msg);
      break;
    case 'team-run-awaiting-input':
      setRunning(refs, true);
      setChatAwaiting(refs, msg.question);
      setStatus(refs, 'Awaiting your answer', 'run');
      break;
    case 'team-run-resumed':
      clearChatAwaiting(refs);
      setStatus(refs, 'Running...', 'run');
      break;
    default:
      break;
  }
}
