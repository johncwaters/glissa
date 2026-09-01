
export const TOUCH_SCROLL_THRESHOLD_PX = 10;

const VERTICAL_DOMINANCE = 1.2;

export const MAX_WHEEL_ROWS_PER_STEP = 8;

export const SCROLL_FRICTION_PX_PER_MS2 = 0.005;

export const VELOCITY_SAMPLE_LIMIT = 4;

export const MIN_FLICK_VELOCITY_PX_PER_MS = 0.08;

export const MAX_FLICK_VELOCITY_PX_PER_MS = 5;

export function isScrollGesture(deltaXPx: number, deltaYPx: number) {
  const vertical = Math.abs(deltaYPx);
  if (vertical < TOUCH_SCROLL_THRESHOLD_PX) return false;
  return vertical > Math.abs(deltaXPx) * VERTICAL_DOMINANCE;
}

export function scrollLinesForDrag(pendingPx: number, cellHeightPx: number, maxRowsPerStep = Number.POSITIVE_INFINITY) {
  if (!(cellHeightPx > 0)) return { scrollLines: 0, remainderPx: pendingPx };
  const rows = Math.trunc(pendingPx / cellHeightPx);
  const capped = Math.max(-maxRowsPerStep, Math.min(maxRowsPerStep, rows));
  return {
    scrollLines: capped === 0 ? 0 : -capped,
    remainderPx: pendingPx - capped * cellHeightPx,
  };
}

export interface VelocitySample {
  positionPx: number;
  timestampMs: number;
}

export function pushVelocitySample(samples: readonly VelocitySample[], positionPx: number, timestampMs: number): VelocitySample[] {
  const kept = samples.length >= VELOCITY_SAMPLE_LIMIT ? samples.slice(1) : samples.slice();
  kept.push({ positionPx, timestampMs });
  return kept;
}

export function releaseVelocity(samples: readonly VelocitySample[] | null | undefined) {
  if (!samples || samples.length < 2) return 0;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const elapsedMs = newest.timestampMs - oldest.timestampMs;
  if (!(elapsedMs > 0)) return 0;
  const velocityPxPerMs = (newest.positionPx - oldest.positionPx) / elapsedMs;
  const speed = Math.abs(velocityPxPerMs);
  if (!(speed >= MIN_FLICK_VELOCITY_PX_PER_MS)) return 0;
  const clampedSpeed = Math.min(speed, MAX_FLICK_VELOCITY_PX_PER_MS);
  return velocityPxPerMs < 0 ? -clampedSpeed : clampedSpeed;
}

export interface InertiaState {
  velocityPxPerMs: number;
  lastMs: number;
  cellHeightPx: number;
  pendingPx: number;
}

export function beginInertia({ velocityPxPerMs, startedAtMs, cellHeightPx, pendingPx = 0 }: {
  velocityPxPerMs: number;
  startedAtMs: number;
  cellHeightPx: number;
  pendingPx?: number;
}): InertiaState | null {
  if (!velocityPxPerMs || !(cellHeightPx > 0)) return null;
  return { velocityPxPerMs, lastMs: startedAtMs, cellHeightPx, pendingPx };
}

export function stepInertia(state: InertiaState | null | undefined, nowMs: number): { scrollLines: number; state: InertiaState | null } {
  if (!state) return { scrollLines: 0, state: null };
  const elapsedMs = nowMs - state.lastMs;
  if (!(elapsedMs > 0)) return { scrollLines: 0, state };

  const decayedSpeed = Math.abs(state.velocityPxPerMs) - SCROLL_FRICTION_PX_PER_MS2 * elapsedMs;
  if (!(decayedSpeed > 0)) return { scrollLines: 0, state: null };

  const direction = state.velocityPxPerMs < 0 ? -1 : 1;
  const travelPx = direction * decayedSpeed * elapsedMs;
  const { scrollLines, remainderPx } = scrollLinesForDrag(state.pendingPx + travelPx, state.cellHeightPx);
  return {
    scrollLines,
    state: {
      velocityPxPerMs: direction * decayedSpeed,
      lastMs: nowMs,
      cellHeightPx: state.cellHeightPx,
      pendingPx: remainderPx,
    },
  };
}

export function shouldSendWheelReport(bufferType: string | null | undefined, mouseTrackingMode: string | null | undefined) {
  if (bufferType === 'alternate') return true;
  return Boolean(mouseTrackingMode) && mouseTrackingMode !== 'none';
}

export function cellHeightFromElement(elementHeightPx: number, rows: number) {
  if (!(elementHeightPx > 0) || !(rows > 0)) return 0;
  return elementHeightPx / rows;
}
