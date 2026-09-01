// ── Value coercion (pure) ────────────────────────────────────
// The two guards the lane view cores read snapshot fields through: a snapshot arrives over the wire,
// so any field can be absent, null, or the wrong type.

export function textOr<Fallback>(value: unknown, fallback: Fallback): string | Fallback {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function numberOr<Fallback>(value: unknown, fallback: Fallback): number | Fallback {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
