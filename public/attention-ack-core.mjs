// ── Attention acknowledgement (pure) ─────────────────────────
// The Radar, PRs and Usage dots used to be raw standing booleans, so a condition that stayed true kept
// its dot lit forever and looking at the surface did nothing. Each surface now describes what is
// alarming as a SIGNATURE, and the dot is shown only while that signature differs from the one the
// operator last acknowledged: seeing the surface clears it, a genuinely new or changed fact re-lights
// it, and the condition ending clears the acknowledgement so its recurrence re-arms.
//
// A signature is deduped and sorted, so the same facts arriving in a different order are the same
// signature; it is a string, so it can be persisted and compared with one equality.

export function attentionSignature(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const cleaned = list.filter((part) => typeof part === 'string' && part !== '');
  return [...new Set(cleaned)].sort().join('|');
}

export function decideAttention(signature, acknowledged) {
  const current = typeof signature === 'string' ? signature : '';
  const seen = typeof acknowledged === 'string' ? acknowledged : '';
  if (current === '') return { shown: false, acknowledged: '' };
  return { shown: current !== seen, acknowledged: seen };
}
