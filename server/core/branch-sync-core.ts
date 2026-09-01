// Pure parsing/decision logic for the review sidebar's branch-sync indicator: whether a project's
// LOCAL base branch is ahead of and/or behind its remote upstream tracking branch. No
// IO here; the caller (session/sessions.js getBranchSync) runs the git commands and hands the raw
// text to parseLeftRightCount, then decideBranchSyncState.

export const GIT_FETCH_TIMEOUT_MS = 8000;

export type BranchSyncState = 'no-upstream' | 'unknown' | 'diverged' | 'ahead' | 'behind' | 'in-sync';
export type ResyncAction = 'ff-merge' | 'ff-fetch' | 'push' | 'none';

export interface LeftRightCount {
  behind: number;
  ahead: number;
}

// Parse `git rev-list --left-right --count <upstream>...<branch>` output. Verified against a real
// diverged repo (2 local-only commits, 1 remote-only commit): the LEFT count is commits reachable
// from upstream but not branch (behind), the RIGHT count is commits reachable from branch but not
// upstream (ahead) - i.e. the output is "<behind><TAB><ahead>", matching `git status -sb`'s "ahead 2,
// behind 1" for that same repo. Tolerates surrounding whitespace and a stray CR. Returns null when
// the shape does not parse (unexpected git output), so the caller can report it as unknown rather
// than trusting a garbage count.
function parseLeftRightCount(output: string | null | undefined): LeftRightCount | null {
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
function decideBranchSyncState({
  hasUpstream,
  ahead,
  behind,
}: {
  hasUpstream: boolean;
  ahead?: number;
  behind?: number;
}): BranchSyncState {
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
function parseRemoteFromUpstream(upstream: string | null | undefined): string {
  const idx = String(upstream || '').indexOf('/');
  if (idx === -1) return 'origin';
  return String(upstream).slice(0, idx);
}

// Decide what an on-demand resync should DO, purely from the already-classified sync state and whether
// the base branch is the one currently checked out in the main checkout. Only 'behind' and 'ahead' ever
// mutate anything; every other state (in-sync, diverged, no-upstream, unknown) is 'none' - a resync
// must never rebase, force-push, or otherwise touch a diverged branch. isCheckedOut decides HOW a
// fast-forward happens: `git merge --ff-only` needs the branch checked out (it advances the working
// tree too), whereas an unchecked-out branch is fast-forwarded via `git fetch <remote> <branch>:<branch>`
// (ff-only by default) so the operator's actual checkout is never touched.
function decideResyncAction(state: string, isCheckedOut: boolean): ResyncAction {
  if (state === 'behind') return isCheckedOut ? 'ff-merge' : 'ff-fetch';
  if (state === 'ahead') return 'push';
  return 'none';
}

export interface ResyncCommandOptions {
  timeout?: number;
  [key: string]: unknown;
}

export interface ResyncCommand {
  args: string[];
  opts: ResyncCommandOptions;
  successAction: 'fast-forwarded' | 'pushed';
}

function buildResyncCommand(
  decision: string,
  { upstream, branch, remote, opts }: { upstream: string; branch: string; remote: string; opts: ResyncCommandOptions },
): ResyncCommand | null {
  if (decision === 'ff-merge') return { args: ['merge', '--ff-only', upstream], opts, successAction: 'fast-forwarded' };
  if (decision === 'ff-fetch') return { args: ['fetch', '--quiet', remote, `${branch}:${branch}`], opts: { ...opts, timeout: GIT_FETCH_TIMEOUT_MS }, successAction: 'fast-forwarded' };
  if (decision === 'push') return { args: ['push', remote, branch], opts: { ...opts, timeout: 15000 }, successAction: 'pushed' };
  return null;
}

// A short, readable line from a failed git command. Strip command echoes, ANSI/control noise,
// then prefer git's own fatal/error/push-rejection line over hook chatter.
function firstGitErrorLine(err: unknown): string {
  // typeof-checked, not a truthiness `||` chain: an Error with a legitimately empty .message must stay
  // empty (and fall through to the generic line below), not stringify the whole Error object to "Error".
  const maxGitErrorLineLength = 200;
  const raw = errorMessageOrText(err);
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

function errorMessageOrText(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  if (!err) return '';
  return String(err);
}

export {
  parseLeftRightCount,
  decideBranchSyncState,
  parseRemoteFromUpstream,
  decideResyncAction,
  buildResyncCommand,
  firstGitErrorLine,
};
