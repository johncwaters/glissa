const DEFAULT_CLAIM_TTL_MS = 4000;

export function claimKey(session: unknown, category: unknown) {
  return `glissa-notify-claim-${session || ''}-${category || ''}`;
}

export function claimNotification(store: Pick<Storage, 'getItem' | 'setItem'>, key: string, now: number, ttlMs = DEFAULT_CLAIM_TTL_MS) {
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
