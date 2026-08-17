// Shared "polled X ago" ticker for the poller-status tabs (PR review, Radar). Each panel renders the
// text once at build and would go stale until the next broadcast; subscribing every panel to the
// shared session tick (session-card/session-tick.js) advances the text without a page refresh, and
// keeping the helper here stops the two panels from each carrying a copy.

import { onSessionTick } from './session-card/session-tick.js';

// The unit ladder every elapsed readout here shares, taking a DURATION rather than a timestamp so a
// span with no "ago" reading (Radar's "stale 12m") wears the same units as the ticking labels.
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// Also used directly for one-shot "X ago" labels that do not tick (the Radar investigations inbox),
// so the two surfaces cannot word the same elapsed time two different ways.
export function formatAgo(ts) {
  if (!Number.isFinite(ts)) return 'never';
  return `${formatDuration(Date.now() - ts)} ago`;
}

// One ticker per panel. `getRoot` hands back the panel's root (or null before mount); a hidden panel
// skips its repaint entirely, and the string-compare guard keeps a visible one from touching the DOM
// until the rendered minute actually changes.
export function createPollAgoTicker(getRoot) {
  let tracked = [];
  let unsubscribe = null;

  const paint = (target, ts) => {
    const next = `polled ${formatAgo(ts)}`;
    if (target.textContent === next) return;
    target.textContent = next;
  };

  const refresh = () => {
    const root = getRoot();
    if (!root || root.closest('[hidden]')) return;
    for (const item of tracked) paint(item.el, item.lastTickAt);
  };

  return {
    // Paints immediately and keeps the element ticking until the next reset().
    track(target, lastTickAt) {
      paint(target, lastTickAt);
      tracked.push({ el: target, lastTickAt });
    },
    // Called at the top of a full re-render, before the old spans are discarded.
    reset() {
      tracked = [];
    },
    // Idempotent; the subscription lives for the page, matching the panels' own lifetime.
    ensure() {
      if (unsubscribe) return;
      unsubscribe = onSessionTick(refresh);
    },
  };
}
