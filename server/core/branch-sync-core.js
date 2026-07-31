'use strict';

// Pure parsing/decision logic for the review sidebar's branch-sync indicator: whether a project's
// LOCAL base branch (e.g. develop) is ahead of and/or behind its remote upstream tracking branch. No
// IO here; the caller (session/sessions.js getBranchSync) runs the git commands and hands the raw
// text to parseLeftRightCount, then decideBranchSyncState.

// Parse `git rev-list --left-right --count <upstream>...<branch>` output. Verified against a real
// diverged repo (2 local-only commits, 1 remote-only commit): the LEFT count is commits reachable
// from upstream but not branch (behind), the RIGHT count is commits reachable from branch but not
// upstream (ahead) - i.e. the output is "<behind><TAB><ahead>", matching `git status -sb`'s "ahead 2,
// behind 1" for that same repo. Tolerates surrounding whitespace and a stray CR. Returns null when
// the shape does not parse (unexpected git output), so the caller can report it as no-upstream rather
// than trusting a garbage count.
function parseLeftRightCount(output) {
  const parts = String(output || '').trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead) || behind < 0 || ahead < 0) return null;
  return { behind, ahead };
}

// Decide the compact display state. hasUpstream:false short-circuits to 'no-upstream' regardless of
// counts (there is nothing to compare against: a fresh local branch, or one whose upstream was never
// configured).
function decideBranchSyncState({ hasUpstream, ahead, behind }) {
  if (!hasUpstream) return 'no-upstream';
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'in-sync';
}

module.exports = { parseLeftRightCount, decideBranchSyncState };
