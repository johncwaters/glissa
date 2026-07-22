// ── Nyan cat easter egg ──────────────────────────────────────
// Mounted only while the Rainbow Unicorns theme is active (see theme.js).
// Each flight re-randomizes vertical position, duration, and gap so no
// two runs look identical; the very first flight also gets a random
// negative animation-delay so it can enter mid-flight.

const MIN_TOP_VH = 5;
const MAX_TOP_VH = 75;
const MIN_DURATION_S = 9;
const MAX_DURATION_S = 15;
const MIN_GAP_MS = 2000;
const MAX_GAP_MS = 10000;

/**
 * Pure randomization for one flight. Takes an injected rng so it is
 * unit-testable without mocking Math.random.
 * @param {() => number} rng
 * @returns {{ topVh: number, durationS: number, gapMs: number, firstDelayS: number }}
 */
export function pickFlight(rng = Math.random) {
  const topVh = MIN_TOP_VH + rng() * (MAX_TOP_VH - MIN_TOP_VH);
  const durationS = MIN_DURATION_S + rng() * (MAX_DURATION_S - MIN_DURATION_S);
  const gapMs = MIN_GAP_MS + rng() * (MAX_GAP_MS - MIN_GAP_MS);
  const firstDelayS = rng() * durationS;
  return { topVh, durationS, gapMs, firstDelayS };
}

let _el = null;
let _timeoutId = null;

function launchFlight(isFirst) {
  if (!_el) return;
  const { topVh, durationS, gapMs, firstDelayS } = pickFlight();
  _el.style.setProperty('--nyan-top', `${topVh}vh`);
  _el.style.animation = `nyan-fly ${durationS}s linear`;
  if (isFirst) {
    _el.style.animationDelay = `-${firstDelayS}s`;
  }
  _el.addEventListener(
    'animationend',
    () => {
      if (!_el) return;
      _el.style.animation = 'none';
      _timeoutId = setTimeout(() => launchFlight(false), gapMs);
    },
    { once: true }
  );
}

/** Mount the flying nyan cat overlay. Idempotent; no-ops under reduced motion. */
export function startNyanCat() {
  if (_el) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const flight = document.createElement('div');
  flight.className = 'nyan-flight';
  const trail = document.createElement('div');
  trail.className = 'nyan-trail';
  const sprite = document.createElement('div');
  sprite.className = 'nyan-sprite';
  flight.appendChild(trail);
  flight.appendChild(sprite);
  document.body.appendChild(flight);
  _el = flight;

  launchFlight(true);
}

/** Remove the nyan cat overlay and cancel any pending flight. Safe if never started. */
export function stopNyanCat() {
  if (_timeoutId !== null) {
    clearTimeout(_timeoutId);
    _timeoutId = null;
  }
  if (_el) {
    _el.remove();
    _el = null;
  }
}
