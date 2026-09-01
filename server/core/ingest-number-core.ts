/*
 * The one copy of the bound coercion every ingest core and IO shell resolves its numeric options
 * through, mirroring server/core/usage-number-core.ts for the usage lane. Six modules held a
 * byte-identical four-line copy of this before it was extracted.
 *
 * server/core/visions-dispatch-core.ts requires it too: the Visions gate resolves its quotas the
 * same way, and one shared helper beats a seventh copy in a neighbouring lane.
 */

// Anything that is not a finite number above zero is not a bound, so the caller's default stands.
function positiveInt(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

export { positiveInt };
