'use strict';

// Shared markdown-heading core for team-output.js (pack/handoff section checks) and team-orchestrator.js
// (topic/platforms extraction from a stage's produced file). All three prior call sites built the same
// "^#{1,6}\\s*<escaped heading>\\b" regex independently; this module is the single source for that.

// Escape a string for literal use inside a RegExp.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Regex matching an ATX heading line for `heading`. matchLine also captures the rest of that line (used
// by callers that need to slice past it), otherwise the match stops at the heading text (presence check).
function headingRegex(heading, { matchLine = false } = {}) {
  const esc = escapeRegExp(heading);
  return new RegExp(`^#{1,6}\\s*${esc}\\b${matchLine ? '.*$' : ''}`, 'im');
}

// Whether `text` contains a heading matching `heading` (used by verifyHandoff's required-section gate).
function hasHeading(text, heading) {
  return headingRegex(heading).test(text);
}

// Text following a matched heading line, or null when the heading is absent. Shared slicing step for
// sectionFirstLine/readParagraph, which then walk the returned text differently.
function textAfterHeading(text, heading) {
  if (!text) return null;
  const m = headingRegex(heading, { matchLine: true }).exec(text);
  if (!m) return null;
  return text.slice(m.index + m[0].length);
}

// First non-empty content line under `heading` (used for a run log's topic/platforms fields).
function sectionFirstLine(text, heading) {
  const rest = textAfterHeading(text, heading);
  if (rest == null) return '';
  for (const line of rest.split(/\r?\n/)) {
    const t = line.trim().replace(/^[-*]\s*/, '');
    if (t && !/^#{1,6}\s/.test(t)) return t;
  }
  return '';
}

// The paragraph (joined non-empty lines) directly under `heading`, stopping at the next heading or a
// blank line once content has started.
function readParagraph(text, heading) {
  const rest = textAfterHeading(text, heading);
  if (rest == null) return '';
  const lines = [];
  for (const raw of rest.split(/\r?\n/)) {
    const t = raw.trim();
    if (/^#{1,6}\s/.test(t)) break; // next heading
    if (t === '' && lines.length) break; // end of paragraph
    if (t) lines.push(t.replace(/^[-*]\s*/, ''));
  }
  return lines.join(' ');
}

module.exports = {
  escapeRegExp, headingRegex, hasHeading, textAfterHeading, sectionFirstLine, readParagraph,
};
