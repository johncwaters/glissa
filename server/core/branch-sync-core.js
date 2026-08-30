'use strict';

// Pure parsing/decision logic for the review sidebar's branch-sync indicator: whether a project's
// LOCAL base branch is ahead of and/or behind its remote upstream tracking branch. No
// IO here; the caller (session/sessions.js getBranchSync) runs the git commands and hands the raw
// text to parseLeftRightCount, then decideBranchSyncState.

// Parse `git rev-list --left-right --count <upstream>...<branch>` output. Verified against a real
// diverged repo (2 local-only commits, 1 remote-only commit): the LEFT count is commits reachable
// from upstream but not branch (behind), the RIGHT count is commits reachable from branch but not
// upstream (ahead) - i.e. the output is "<behind><TAB><ahead>", matching `git status -sb`'s "ahead 2,
// behind 1" for that same repo. Tolerates surrounding whitespace and a stray CR. Returns null when
// the shape does not parse (unexpected git output), so the caller can report it as unknown rather
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
// configured). An upstream with missing/unparseable counts is 'unknown', a distinct state from
// 'no-upstream' so a fetch failure on that path is still surfaced as stale by the UI.
/** @param {{ hasUpstream: boolean, ahead?: number, behind?: number }} options */
function decideBranchSyncState({ hasUpstream, ahead, behind }) {
  if (!hasUpstream) return 'no-upstream';
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return 'unknown';
  if (ahead === undefined || behind === undefined) return 'unknown';
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'in-sync';
}

// Remote name from an upstream ref like "origin/main" -> "origin". Defensive fallback of 'origin'
// for a slash-less value (should not happen for a real @{upstream} result, but a resync must never be
// pointed at an empty remote name).
function parseRemoteFromUpstream(upstream) {
  const idx = String(upstream || '').indexOf('/');
  return idx === -1 ? 'origin' : upstream.slice(0, idx);
}

// Decide what an on-demand resync should DO, purely from the already-classified sync state and whether
// the base branch is the one currently checked out in the main checkout. Only 'behind' and 'ahead' ever
// mutate anything; every other state (in-sync, diverged, no-upstream, unknown) is 'none' - a resync
// must never rebase, force-push, or otherwise touch a diverged branch. isCheckedOut decides HOW a
// fast-forward happens: `git merge --ff-only` needs the branch checked out (it advances the working
// tree too), whereas an unchecked-out branch is fast-forwarded via `git fetch <remote> <branch>:<branch>`
// (ff-only by default) so the operator's actual checkout is never touched.
function decideResyncAction(state, isCheckedOut) {
  if (state === 'behind') return isCheckedOut ? 'ff-merge' : 'ff-fetch';
  if (state === 'ahead') return 'push';
  return 'none';
}

// A short, readable line from a failed git command. Strip command echoes, ANSI/control noise,
// then prefer git's own fatal/error/push-rejection line over hook chatter.
function firstGitErrorLine(err) {
  // typeof-checked, not a truthiness `||` chain: an Error with a legitimately empty .message must stay
  // empty (and fall through to the generic line below), not stringify the whole Error object to "Error".
  const maxGitErrorLineLength = 200;
  const raw = err && typeof err.message === 'string' ? err.message : String(err || '');
  const msg = raw
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/^Command failed:[^\n]*\n?/, '');
  const lines = msg.split('\n').map((line) => line.trim()).filter(Boolean);
  const preferredLine = lines.find((line) => line.startsWith('fatal:') || line.startsWith('error:') || line.startsWith('! ['));
  const line = preferredLine || lines[0];
  return line ? line.slice(0, maxGitErrorLineLength) : 'git command failed';
}

module.exports = { parseLeftRightCount, decideBranchSyncState, parseRemoteFromUpstream, decideResyncAction, firstGitErrorLine };
