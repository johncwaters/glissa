"use strict";

// Pure text for the live pack-notice channel: when a context pack a session is already running on
// gets rebuilt, its next UserPromptSubmit hook response carries this one notice through
// hookSpecificOutput.additionalContext (docs/plan-context-mill.md, lever 2). No IO, no Session import.
//
// The notice is GLISSA-AUTHORED ONLY: it names the pack and the two versions and points at the added
// directory, and never carries a byte of pack content. That is a security property, not a style
// choice - the live channel must not become a relay for text a pack source could plant.
//
// Claude Code caps additionalContext near 10000 chars; a per-turn notice has no business anywhere
// near that, so the pack list truncates after a handful and the whole string is hard-capped.

const MAX_LISTED_PACKS = 3;
const MAX_NOTICE_CHARS = 600;
const VERSION_CHARS = 12;
const TRUNCATION_TAIL = " (truncated)";

function shortVersion(version) {
  return typeof version === "string" ? version.slice(0, VERSION_CHARS) : "unknown";
}

function readLatest(latestVersions, name) {
  if (!latestVersions) return null;
  const value = typeof latestVersions.get === "function" ? latestVersions.get(name) : latestVersions[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Delivered packs whose latest built version differs from the one this session spawned against. */
function listStalePacks(deliveredPacks, latestVersions) {
  if (!Array.isArray(deliveredPacks)) return [];
  const stale = [];
  for (const pack of deliveredPacks) {
    if (!pack || typeof pack.name !== "string") continue;
    const latest = readLatest(latestVersions, pack.name);
    if (!latest || latest === pack.version) continue;
    stale.push({ name: pack.name, from: shortVersion(pack.version), to: shortVersion(latest) });
  }
  return stale;
}

/** The notice text for the current staleness, or null when nothing this session runs on has moved. */
function buildPackNotice(deliveredPacks, latestVersions) {
  const stale = listStalePacks(deliveredPacks, latestVersions);
  if (stale.length === 0) return null;

  const listed = stale.slice(0, MAX_LISTED_PACKS).map((pack) => `"${pack.name}" (version ${pack.from} is now ${pack.to})`);
  const remaining = stale.length - listed.length;
  if (remaining > 0) listed.push(`and ${remaining} more`);

  const label = stale.length === 1 ? "Context pack updated" : "Context packs updated";
  const notice =
    `[glissa] ${label} since this session started: ${listed.join("; ")}. `
    + "The pack CLAUDE.md and rules text loaded at spawn may be out of date. "
    + "Re-read the files under the pack directory added to this session if they matter for this turn.";
  if (notice.length <= MAX_NOTICE_CHARS) return notice;
  return notice.slice(0, MAX_NOTICE_CHARS - TRUNCATION_TAIL.length) + TRUNCATION_TAIL;
}

function shouldHoldTerminalStopForNotice({ event, signal, isNoticePending, packNoticeHookEvent }) {
  if (!isNoticePending) return false;
  if (signal !== "ready") return false;
  if (String(packNoticeHookEvent || "").toLowerCase() !== "stop") return false;
  return String(event || "").toLowerCase() === "stop";
}

module.exports = {
  buildPackNotice,
  listStalePacks,
  shouldHoldTerminalStopForNotice,
  MAX_LISTED_PACKS,
  MAX_NOTICE_CHARS,
};
