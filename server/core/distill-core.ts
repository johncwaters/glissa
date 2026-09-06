const STAMP_PREFIX = '<!-- glissa-distill v1 ';
const STAMP_SUFFIX = ' -->';

const STAMP_HASH_CHARS = 16;

export interface StampSource {
  path: string;
  sha256: string;
}

export interface DistillStamp {
  sources: StampSource[];
}

export interface DistillVerdict {
  stale: boolean;
  reason: string | null;
}

function shortHash(sha256: unknown): string {
  return String(sha256 == null ? '' : sha256).slice(0, STAMP_HASH_CHARS);
}

function byPath(a: StampSource, b: StampSource): number {
  if (a.path === b.path) return 0;
  if (a.path < b.path) return -1;
  return 1;
}

function normalizeStampSources(sources: unknown): StampSource[] {
  const byPathKey = new Map<string, StampSource>();
  const list: unknown[] = Array.isArray(sources) ? sources : [];
  for (const source of list) {
    if (!source || typeof source !== 'object') continue;
    if (!('path' in source) || !('sha256' in source)) continue;
    const { path, sha256 } = source;
    if (typeof path !== 'string' || typeof sha256 !== 'string') continue;
    byPathKey.set(path, { path, sha256: shortHash(sha256) });
  }
  return [...byPathKey.values()].sort(byPath);
}

function buildStampLine(sources: unknown): string {
  return `${STAMP_PREFIX}${JSON.stringify(normalizeStampSources(sources))}${STAMP_SUFFIX}`;
}

function parseStampLine(content: unknown): DistillStamp | null {
  if (typeof content !== 'string' || content.length === 0) return null;
  const firstLine = content.split('\n', 1)[0].replace(/\r$/, '').trim();
  if (!firstLine.startsWith(STAMP_PREFIX) || !firstLine.endsWith(STAMP_SUFFIX)) return null;
  const payload = firstLine.slice(STAMP_PREFIX.length, firstLine.length - STAMP_SUFFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const sources = normalizeStampSources(parsed);
  if (sources.length !== parsed.length) return null;
  return { sources };
}

function needsDistill(currentSources: StampSource[], content: string | null): DistillVerdict {
  if (typeof content !== 'string' || content.length === 0) {
    return { stale: true, reason: 'output file is missing' };
  }
  const stamp = parseStampLine(content);
  if (!stamp) return { stale: true, reason: 'output file carries no distill stamp' };
  if (buildStampLine(stamp.sources) !== buildStampLine(currentSources)) {
    return { stale: true, reason: 'sources changed since the last distill' };
  }
  return { stale: false, reason: null };
}

export {
  STAMP_HASH_CHARS,
  buildStampLine,
  needsDistill,
  normalizeStampSources,
  parseStampLine,
  shortHash,
};
