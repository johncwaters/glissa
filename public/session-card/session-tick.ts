import { STATES } from '#shared/states.ts';
import { refreshSessionActivity } from './activity.ts';
import type { SessionUi } from './card-registry.ts';
import { sessionUIs } from './card-registry.ts';

const ELAPSED_STATES = new Set<string>([STATES.RUNNING, STATES.WAITING, STATES.STARTING, STATES.INITIALIZING]);
const showsElapsed = (state: string) => ELAPSED_STATES.has(state);

function fmtElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function sessionElapsedText(ui: SessionUi) {
  return showsElapsed(ui.currentState) ? fmtElapsed(Date.now() - (ui.stateSince || Date.now())) : '';
}

export function refreshElapsed(ui: SessionUi) {
  if (ui.elapsedEl) ui.elapsedEl.textContent = sessionElapsedText(ui);
}

const tickSubscribers = new Set<() => void>();

export function onSessionTick(notify: () => void) {
  tickSubscribers.add(notify);
  return () => tickSubscribers.delete(notify);
}

setInterval(() => {
  for (const [, ui] of sessionUIs) {
    refreshElapsed(ui);
    refreshSessionActivity(ui);
  }
  for (const notify of tickSubscribers) {
    try { notify(); } catch {  }
  }
}, 1000);
