export function attentionSignature(parts: unknown) {
  const list: unknown[] = Array.isArray(parts) ? parts : [];
  const cleaned = list.filter((part): part is string => typeof part === 'string' && part !== '');
  return [...new Set(cleaned)].sort().join('|');
}

export function decideAttention(signature: unknown, acknowledged: unknown) {
  const current = typeof signature === 'string' ? signature : '';
  const seen = typeof acknowledged === 'string' ? acknowledged : '';
  if (current === '') return { shown: false, acknowledged: '' };
  return { shown: current !== seen, acknowledged: seen };
}

export function createAttentionAck({ getAck, setAck, signature, isLooking }: { getAck: () => string; setAck: (next: string) => void; signature: () => string; isLooking: () => boolean }) {
  let acknowledged = getAck();
  const store = (next: string) => {
    if (next === acknowledged) return;
    acknowledged = next;
    setAck(next);
  };
  return {
    refresh() {
      const current = signature();
      const decision = decideAttention(current, isLooking() ? current : acknowledged);
      store(decision.acknowledged);
      return decision.shown;
    },
    acknowledge() {
      store(signature());
    },
  };
}
