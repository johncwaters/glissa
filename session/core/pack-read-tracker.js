'use strict';

// Pure pack-read telemetry: did a Read tool call touch a delivered context pack, and what has each
// pack been read since it was delivered (and since the last staleness notice). No IO and no clock -
// the caller passes ts, like the other cores here. The IO shell is sessions.js (_trackPackRead);
// the counters surface on toSnapshot().packs, the debug overlay, and the recording footer.
//
// Normalization is decided by path SHAPE, never process.platform, so a Windows-shaped path compares
// the same way in a test on any host: Claude reports the path the agent typed, Glissa resolved the
// pack dir itself, and on Windows the two routinely differ in slash kind and case.

function collapseDotSegments(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '.') continue;
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..' && out[out.length - 1] !== '') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function normalizePath(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return '';
  let normalized = raw.replace(/\\/g, '/');
  const isUnc = normalized.startsWith('//');
  normalized = collapseDotSegments(normalized.replace(/\/{2,}/g, '/'));
  if (isUnc) normalized = `/${normalized}`;
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  const windowsShaped = isUnc || /^[a-zA-Z]:($|\/)/.test(normalized);
  return windowsShaped ? normalized.toLowerCase() : normalized;
}

function isWithin(dirNormalized, fileNormalized) {
  if (!dirNormalized || !fileNormalized) return false;
  if (fileNormalized === dirNormalized) return true;
  const prefix = dirNormalized.endsWith('/') ? dirNormalized : `${dirNormalized}/`;
  return fileNormalized.startsWith(prefix);
}

/**
 * The delivered pack whose dir contains `filePath`, or null for every other path (most Read
 * callbacks describe ordinary repo files). Longest dir wins, so a pack nested inside another
 * pack's dir is attributed to itself rather than its container.
 * @param {string} filePath
 * @param {Array<{name: string, dir: string}>} deliveredPacks
 * @returns {string|null}
 */
function packForPath(filePath, deliveredPacks) {
  const fileNormalized = normalizePath(filePath);
  if (!fileNormalized || !Array.isArray(deliveredPacks)) return null;
  const candidates = deliveredPacks
    .filter((pack) => pack && typeof pack.name === 'string' && typeof pack.dir === 'string' && pack.dir)
    .map((pack) => ({ name: pack.name, dirNormalized: normalizePath(pack.dir) }))
    .sort((a, b) => b.dirNormalized.length - a.dirNormalized.length);
  for (const candidate of candidates) {
    if (isWithin(candidate.dirNormalized, fileNormalized)) return candidate.name;
  }
  return null;
}

/** Per-session read counters. `noticeArmed` stays false until a staleness notice is actually taken. */
function createPackReadState() {
  return { byPack: new Map(), noticeArmed: false, noticeAt: null };
}

/** Count one read against a pack. Returns whether it counted (an unnamed pack is ignored). */
function notePackRead(state, packName, ts) {
  if (!state || typeof packName !== 'string' || !packName) return false;
  const entry = state.byPack.get(packName) || { reads: 0, lastReadAt: null, readsSinceNotice: 0 };
  entry.reads += 1;
  entry.lastReadAt = Number.isFinite(ts) ? ts : null;
  if (state.noticeArmed) entry.readsSinceNotice += 1;
  state.byPack.set(packName, entry);
  return true;
}

// Called when a staleness notice was injected into a turn: from here the per-pack count restarts, so
// the M4 channel's effect (did the agent re-read the pack it was told had changed?) is measurable.
function armNoticeCounter(state, ts) {
  if (!state) return;
  state.noticeArmed = true;
  state.noticeAt = Number.isFinite(ts) ? ts : null;
  for (const entry of state.byPack.values()) entry.readsSinceNotice = 0;
}

/** Counters for one pack. `readsSinceNotice` is null until a notice arms it. */
function packReadStats(state, packName) {
  const entry = state?.byPack ? state.byPack.get(packName) : null;
  const armed = !!state?.noticeArmed;
  return {
    reads: entry ? entry.reads : 0,
    lastReadAt: entry ? entry.lastReadAt : null,
    readsSinceNotice: armed ? (entry ? entry.readsSinceNotice : 0) : null,
  };
}

/** One row per delivered pack, in delivery order: the shape the debug overlay and footer report. */
function summarizePackReads(state, deliveredPacks) {
  const packs = Array.isArray(deliveredPacks) ? deliveredPacks : [];
  return packs
    .filter((pack) => pack && typeof pack.name === 'string')
    .map((pack) => ({
      name: pack.name,
      version: pack.version == null ? null : pack.version,
      ...packReadStats(state, pack.name),
    }));
}

/** A spawn re-resolves what is delivered, so the previous spawn's counts are void. */
function clearPackReads(state) {
  if (!state) return;
  state.byPack.clear();
  state.noticeArmed = false;
  state.noticeAt = null;
}

module.exports = {
  normalizePath,
  packForPath,
  createPackReadState,
  notePackRead,
  armNoticeCounter,
  packReadStats,
  summarizePackReads,
  clearPackReads,
};
