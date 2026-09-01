import { STATES } from '#shared/states.ts';
import type { SessionUi } from './card-registry.ts';

const BEAT_THROTTLE_MS = 320;
const QUIET_AFTER_MS = 8000;

export type ActivityRenderKind = 'beat' | 'flag';
export type ActivityRenderer = (ui: SessionUi, kind: ActivityRenderKind) => void;

let renderer: ActivityRenderer | null = null;
export function setActivityRenderer(fn: ActivityRenderer | null) { renderer = fn; }

export function noteSessionOutput(ui: SessionUi | null | undefined) {
  if (!ui || ui.currentState !== STATES.RUNNING) return;
  const now = performance.now();
  ui._lastOutputAt = now;
  if (now - (ui._activityGate || 0) < BEAT_THROTTLE_MS) return;
  ui._activityGate = now;
  if (ui._activity === 'quiet') { ui._activity = 'active'; renderer?.(ui, 'flag'); }
  renderer?.(ui, 'beat');
}

export function refreshSessionActivity(ui: SessionUi | null | undefined) {
  if (!ui || ui.currentState !== STATES.RUNNING) return;
  const next = performance.now() - (ui._lastOutputAt || 0) >= QUIET_AFTER_MS ? 'quiet' : 'active';
  if (ui._activity !== next) { ui._activity = next; renderer?.(ui, 'flag'); }
}

export function setRunningActivity(ui: SessionUi | null | undefined, running: boolean) {
  if (!ui) return;
  if (running) {
    ui._lastOutputAt = performance.now();
    ui._activityGate = 0;
    ui._activity = 'active';
  }
  if (!running) ui._activity = undefined;
  renderer?.(ui, 'flag');
}
