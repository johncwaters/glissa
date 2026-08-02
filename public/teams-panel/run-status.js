// ── Running indicator ─────────────────────────────────────────
// Status text, the collapse/expand resting state, and the per-stage elapsed clock.

import { markStage, stageIndexLabel } from './pipeline.js';
import { clearChatAwaiting } from './chat.js';
import { labelFor, mmss } from './format-core.mjs';

export function setStatus(refs, text, kind) {
  refs.status.textContent = text;
  refs.status.dataset.kind = kind || '';
}

// Compact resting state: idle, configured panels collapse to header + Run. They expand on the chevron,
// when a run starts, or when setup is needed. Elements stay in the DOM (live handlers keep updating
// them); CSS just hides the lower bands while collapsed.
export function setCollapsed(refs, collapsed) {
  refs.collapsed = collapsed;
  refs.panel.classList.toggle('collapsed', collapsed);
  if (refs.collapseBtn) {
    refs.collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    refs.collapseBtn.setAttribute('aria-label', collapsed ? 'Expand team details' : 'Collapse team details');
  }
}

function tickElapsed(refs) {
  const sec = refs.stageStartMs ? Math.round((Date.now() - refs.stageStartMs) / 1000) : 0;
  refs.elapsedEl.textContent = `${mmss(sec)} / ${mmss(refs.budget)}`;
  // Tint the timer once a stage runs past its budget, so a stuck stage reads at a glance.
  refs.elapsedEl.classList.toggle('over-budget', refs.budget > 0 && sec > refs.budget);
}

export function startStageClock(refs) { refs.stageStartMs = Date.now(); if (refs.timer) tickElapsed(refs); }

export function setRunning(refs, on) {
  refs.running = on;
  if (on) setCollapsed(refs, false); // a running team always shows its pipeline
  refs.runGroup.classList.toggle('running', on);
  // The schedule option is not actionable mid-run and reads as confusing next to Cancel, so hide it via
  // the .run-active state class (CSS). We use a class rather than the .hidden property because the
  // schedule toggle has display:inline-flex, which would override the UA [hidden] rule. Remove stays
  // visible-but-disabled.
  refs.panel.classList.toggle('run-active', on);
  refs.runBtn.hidden = on;
  refs.cancelBtn.hidden = !on;
  refs.removeBtn.disabled = on;
  // The conversation input is only actionable during a run (postMessage needs an active run).
  if (refs.chatField) {
    refs.chatField.disabled = !on;
    refs.chatField.placeholder = on
      ? 'Message the team: steer it, or answer a question'
      : 'Run the team to chat with it';
  }
  if (!on) clearChatAwaiting(refs);
  if (on) {
    refs.editor.wrap.hidden = true; // force-close a possibly-open editor so it cannot reappear post-run
    refs.editBtn.setAttribute('aria-expanded', 'false');
    if (!refs.timer) {
      if (!refs.stageStartMs) refs.stageStartMs = Date.now();
      refs.timer = setInterval(() => tickElapsed(refs), 1000);
      tickElapsed(refs);
    }
    return;
  }
  refs.schedCb.checked = refs.enabled; // re-sync on un-hide (covers team-run-skipped, no refreshInstance)
  if (refs.timer) {
    clearInterval(refs.timer);
    refs.timer = null;
    refs.elapsedEl.textContent = '';
    refs.stageStartMs = 0;
  }
}

// Rehydrate a freshly-mounted panel from the server's live snapshot so a tab switch (or a second
// client) restores the active stage, a continuous elapsed timer, and any in-flight cancel, instead
// of a blank rail, a zeroed clock, and a generic "Running...". The timer continues from the server's
// stageStartedAtMs (the Glissa client and server share one machine, so Date.now() is a common clock).
export function rehydrateLive(refs, live) {
  if (live && live.stageStartedAtMs) refs.stageStartMs = live.stageStartedAtMs;
  setRunning(refs, true); // setRunning keeps the stageStartMs we set above, so elapsed is true wall-clock
  if (live && live.currentStage) {
    markStage(refs.stageNodes, live.currentStage, 'active');
    setStatus(refs, `${labelFor(live.currentStage)} · ${stageIndexLabel(refs, live.currentStage)}`, 'run');
  }
  if (!live || !live.currentStage) setStatus(refs, 'Running...', 'run');
  if (live && live.cancelling) setStatus(refs, 'Cancelling...', '');
}
