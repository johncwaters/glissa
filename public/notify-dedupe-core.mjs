// Pure cross-tab notification claim (same seam pattern as session-card/*-core.mjs).
// Multiple open dashboard tabs each receive every `notify` broadcast; with
// renotify:true each construction re-alerts, so two tabs = two pops for one event.
// localStorage is shared per-origin and its writes are serialized, so a short-TTL
// claim keyed by session+category lets exactly one tab (in practice the first to
// process the message) raise the toast. TTL, not a permanent latch: an escalation
// re-fire minutes later must claim again.
//
// `store` is localStorage-shaped ({ getItem, setItem }); injected for tests.

const DEFAULT_CLAIM_TTL_MS = 4000;

export function claimKey(session, category) {
  return `glissa-notify-claim-${session || ''}-${category || ''}`;
}

// True exactly when this caller wins the claim (no live claim existed). False when
// another tab claimed within ttlMs. Any storage failure returns true: a broken or
// unavailable store must never silence notifications (single-tab is the common case).
export function claimNotification(store, key, now, ttlMs = DEFAULT_CLAIM_TTL_MS) {
  try {
    const raw = store.getItem(key);
    if (raw) {
      const prev = Number(raw);
      if (Number.isFinite(prev) && now - prev < ttlMs) return false;
    }
    store.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}
