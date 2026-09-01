/*
 * Pure core of the git ingest source (docs/plan-ingestion.md, M8): the git argument vectors, porcelain
 * v2 and one-line-log parsing, the watch-set derivation, the working-tree signature, and the decision of
 * which single event a settled repo owes. No IO, no timers, no clock: the shell hands in stdout and a
 * `now` and gets a verdict back.
 *
 * The SIGNATURE is the load-bearing piece. Watchers say look again and the owner recomputes (the repo's
 * standing invariant), so a `.git` write burst, the 60s poll and a linked worktree's own churn all funnel
 * into the same recompute; without a signature to compare against, each of those paths would publish the
 * same unchanged working tree again. Since M7.5 every published event is also the Visions lane's movement
 * signal, so a no-op event costs dispatch budget, not just a ring slot.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { SOURCE_DEFAULTS } from './ingest-core.ts';

const SOURCE = 'git';

// The config resolver owns these numbers; re-exporting them here keeps the shell's direct-construction
// fallback from ever drifting from what a resolved config carries.
const DEFAULT_DEBOUNCE_MS = SOURCE_DEFAULTS.git.debounceMs;
const DEFAULT_POLL_MS = SOURCE_DEFAULTS.git.pollMs;

const SHORT_SHA_CHARS = 7;
const CLEAN_SIGNATURE = 'clean';

export interface GitStatusCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface GitStatus {
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  counts: GitStatusCounts;
  signature: string;
}

export interface GitCommit {
  sha: string;
  author: string | null;
  committedAt: number | null;
  subject: string;
}

export interface GitRepoState {
  initialized: boolean;
  branch: string | null;
  oid: string | null;
  signature: string | null;
}

export type GitIngestEvent = {
  source: string;
  kind: string;
  ts: number;
  scope: { root: string | null; sessionId: string | null };
  summary: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface GitLayout {
  toplevel: string;
  gitDir: string;
  commonDir: string;
}

/*
 * One resolve spawn answers every layout question: where the working tree starts, which gitdir holds THIS
 * checkout's HEAD and index (a linked worktree keeps its own under `worktrees/<name>`), and which common
 * dir holds the shared refs. rev-parse emits one line per option, in the order the options were given.
 */
const REV_PARSE_ARGS = Object.freeze(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);

/*
 * `--no-optional-locks` is the whole reason the reader cannot chase its own tail: a plain `git status`
 * refreshes and REWRITES `.git/index`, which is a file this source watches, so every read would wake the
 * next one. It is also VS Code's own git-extension flag, the prior art this plan names.
 */
const STATUS_ARGS = Object.freeze(['--no-optional-locks', 'status', '--porcelain=v2', '--branch']);

// ASCII unit separator, built rather than typed (house rule on literal control characters). Any printable
// subject survives it, which a space or a pipe would not.
const LOG_FIELD_SEPARATOR = String.fromCharCode(31);
const LOG_ARGS = Object.freeze(['log', '-1', '--no-color', '--format=%H%x1f%an%x1f%at%x1f%s']);

/*
 * A commit subject is `%s`, which is one line already, so this trims and nothing else. It deliberately
 * does NOT slice: a cut taken before the publish-time scrub can split a quoted secret out of its closing
 * quote and publish the rest of the value as innocent words (docs/plan-ingestion.md, M11), and the ring's
 * own 400-char bound already slices the composed summary AFTER the scrub has seen it whole.
 */
function commitSubject(text: unknown): string {
  return String(text == null ? '' : text).trim();
}

function shortSha(sha: unknown): string | null {
  if (typeof sha !== 'string' || !sha) return null;
  return sha.slice(0, SHORT_SHA_CHARS);
}

// --- Layout ---------------------------------------------------------------

/**
 * The three rev-parse lines, absolute. git prints POSIX separators even on Windows and `--git-common-dir`
 * may come back relative to the cwd it ran in, so both are resolved against that cwd rather than trusted.
 */
function parseRevParse(stdout: unknown, cwd: string | null | undefined): GitLayout | null {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return null;
  const [toplevel, gitDir, commonDir] = lines;
  const base = path.resolve(String(cwd || toplevel));
  return {
    toplevel: path.resolve(base, toplevel),
    gitDir: path.resolve(base, gitDir),
    commonDir: path.resolve(base, commonDir),
  };
}

/**
 * DIRECTORIES, never files. `HEAD`, `index` and `packed-refs` are all replaced by rename rather than
 * written in place, so a watch on the file itself dies with the inode it was opened against on the first
 * commit; a watch on the directory holding them survives every rewrite. `refs/heads` is watched
 * non-recursively for the same reason the poll exists: a nested branch name (`feature/x`) lives in a
 * subdirectory this never sees, and a `git pack-refs` moves the whole tree into `packed-refs` at once.
 */
function deriveWatchDirs({ gitDir = null, commonDir = null }: { gitDir?: string | null; commonDir?: string | null } = {}): string[] {
  const dirs: string[] = [];
  for (const dir of [commonDir, commonDir ? path.join(commonDir, 'refs', 'heads') : null, gitDir]) {
    if (!dir || dirs.includes(dir)) continue;
    dirs.push(dir);
  }
  return dirs;
}

/*
 * Lock and temp churn is git talking to itself: `index.lock` alone appears and vanishes several times in
 * one commit, and none of those names ever carries state worth recomputing for. A watch event with no
 * filename (Windows reports one for some batched writes) is NOT noise, because there is nothing to judge
 * and dropping it would lose the event the poll would otherwise have to find 60 seconds later.
 */
function isNoiseGitFile(filename: unknown): boolean {
  if (typeof filename !== 'string' || !filename) return false;
  const base = filename.split(/[\\/]/).pop();
  if (!base) return false;
  return base.endsWith('.lock') || base.endsWith('.tmp') || base.startsWith('tmp_obj_');
}

// --- Porcelain v2 ---------------------------------------------------------

// Skip `count` space-delimited fields and return the rest of the line verbatim, which is how a path
// containing spaces survives: porcelain v2 puts the path last precisely so it never needs quoting.
function tailAfterFields(line: string, count: number): string {
  let index = 0;
  for (let field = 0; field < count; field += 1) {
    const next = line.indexOf(' ', index);
    if (next < 0) return '';
    index = next + 1;
  }
  return line.slice(index);
}

function fieldAt(line: string, index: number): string {
  return line.split(' ')[index] || '';
}

function readHeader(status: GitStatus, header: string): void {
  if (header.startsWith('branch.oid ')) {
    const value = header.slice('branch.oid '.length).trim();
    // A repo with no commits reports the literal `(initial)` rather than a sha.
    if (value === '(initial)') {
      status.unborn = true;
      return;
    }
    status.oid = value || null;
    return;
  }
  if (header.startsWith('branch.head ')) {
    const value = header.slice('branch.head '.length).trim();
    if (value === '(detached)') {
      status.detached = true;
      return;
    }
    status.branch = value || null;
    return;
  }
  if (header.startsWith('branch.upstream ')) {
    status.upstream = header.slice('branch.upstream '.length).trim() || null;
    return;
  }
  if (!header.startsWith('branch.ab ')) return;
  const [ahead, behind] = header.slice('branch.ab '.length).trim().split(' ');
  status.ahead = Math.abs(Number.parseInt(ahead, 10)) || 0;
  status.behind = Math.abs(Number.parseInt(behind, 10)) || 0;
}

/*
 * A HASH, not the entry list. A repo mid-`npm install` reports thousands of untracked paths, and holding
 * that string per repo forever to compare against the next read is the kind of unbounded retention the
 * ring caps exist to prevent. The count rides along so two trees of different sizes never collide on the
 * digest alone.
 */
function signatureOf(entries: string[]): string {
  if (entries.length === 0) return CLEAN_SIGNATURE;
  const sorted = [...entries].sort();
  const digest = crypto.createHash('sha1').update(sorted.join('\n'), 'utf8').digest('hex');
  return `${sorted.length}:${digest.slice(0, 16)}`;
}

/**
 * `git status --porcelain=v2 --branch`, read into the branch facts, the four counts a one-line summary
 * needs, and the signature everything downstream dedupes on. Deliberately tolerant: an unrecognized line
 * is skipped rather than failing the read, because a future git can add header kinds and this source's
 * job is to keep publishing what it does understand.
 */
function parsePorcelainStatus(stdout: unknown): GitStatus {
  const status: GitStatus = {
    branch: null,
    detached: false,
    unborn: false,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    signature: CLEAN_SIGNATURE,
  };
  const entries: string[] = [];
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith('# ')) {
      readHeader(status, line.slice(2));
      continue;
    }
    const kind = line[0];
    if (kind === '1' || kind === '2') {
      const xy = fieldAt(line, 1);
      // A rename's line ends `<path><tab><origPath>`; both halves belong in the signature, so the whole
      // tail is kept rather than split.
      const target = tailAfterFields(line, kind === '1' ? 8 : 9);
      if (xy[0] && xy[0] !== '.') status.counts.staged += 1;
      if (xy[1] && xy[1] !== '.') status.counts.unstaged += 1;
      entries.push(`${kind} ${xy} ${target}`);
      continue;
    }
    if (kind === 'u') {
      status.counts.conflicted += 1;
      entries.push(`u ${fieldAt(line, 1)} ${tailAfterFields(line, 10)}`);
      continue;
    }
    // `!` lines only appear under --ignored, which this source never asks for.
    if (kind !== '?') continue;
    status.counts.untracked += 1;
    entries.push(`? ${line.slice(2)}`);
  }
  status.signature = signatureOf(entries);
  return status;
}

/**
 * The single `git log -1` line. Returns null for anything that is not a sha-led record, which is what an
 * unborn branch produces: git exits non-zero there and the shell hands the empty stdout straight through.
 */
function parseCommitLine(stdout: unknown): GitCommit | null {
  const line = String(stdout || '').split('\n')[0];
  if (!line) return null;
  const fields = line.split(LOG_FIELD_SEPARATOR);
  const sha = (fields[0] || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  const seconds = Number(fields[2]);
  return {
    sha,
    author: (fields[1] || '').trim() || null,
    committedAt: Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : null,
    subject: commitSubject(fields.slice(3).join(LOG_FIELD_SEPARATOR)),
  };
}

// --- Decisions ------------------------------------------------------------

function createRepoState(): GitRepoState {
  return { initialized: false, branch: null, oid: null, signature: null };
}

/**
 * Whether this read owes a second spawn. The subject is only ever needed when HEAD actually moved or the
 * branch changed under it, so the common case (a working-tree edit, or a trigger that turned out to be
 * nothing) costs exactly one `git status` and no log at all.
 */
function shouldReadCommit(
  previous: Partial<GitRepoState> | null | undefined,
  status: { oid?: string | null; branch?: string | null } | null | undefined,
): boolean {
  if (!previous || previous.initialized !== true) return false;
  if (!status || !status.oid) return false;
  return previous.oid !== status.oid || previous.branch !== status.branch;
}

function branchLabel(status: GitStatus): string {
  if (status.unborn) return status.branch ? `${status.branch} (no commits yet)` : 'unborn branch';
  if (status.detached || !status.branch) return 'detached HEAD';
  return status.branch;
}

function subjectSuffix(commit: Partial<GitCommit> | null | undefined): string {
  if (!commit || !commit.subject) return '';
  return `: ${commit.subject}`;
}

interface EventInput {
  status: GitStatus;
  commit?: Partial<GitCommit> | null;
  root?: string | null;
  now?: number;
}

function commitEvent({ status, commit, root = null, now = 0 }: EventInput): GitIngestEvent {
  const sha = shortSha(commit?.sha || status.oid);
  return {
    source: SOURCE,
    kind: 'commit',
    // ARRIVAL time, not the commit's own: a rebase replays week-old author dates, and the digest renders
    // ts as an age, so trusting the record would print a stale age for something that just happened.
    ts: now,
    scope: { root, sessionId: null },
    summary: `commit ${sha} on ${branchLabel(status)}${subjectSuffix(commit)}`,
    detail: {
      sha: commit?.sha || status.oid,
      branch: status.branch || null,
      author: commit?.author || null,
      committedAt: commit?.committedAt || null,
    },
  };
}

function branchChangeEvent({ status, commit, root = null, now = 0 }: EventInput): GitIngestEvent {
  const sha = shortSha(commit?.sha || status.oid);
  const at = sha ? ` at ${sha}` : '';
  return {
    source: SOURCE,
    kind: 'branch-change',
    ts: now,
    scope: { root, sessionId: null },
    summary: `switched to ${branchLabel(status)}${at}${subjectSuffix(commit)}`,
    detail: { branch: status.branch || null, detached: status.detached, oid: status.oid },
  };
}

function statusChangeEvent({ status, root = null, now = 0 }: EventInput): GitIngestEvent {
  const { counts } = status;
  const parts: string[] = [];
  if (counts.staged) parts.push(`${counts.staged} staged`);
  if (counts.unstaged) parts.push(`${counts.unstaged} modified`);
  if (counts.untracked) parts.push(`${counts.untracked} untracked`);
  if (counts.conflicted) parts.push(`${counts.conflicted} conflicted`);
  return {
    source: SOURCE,
    kind: 'status-change',
    ts: now,
    scope: { root, sessionId: null },
    summary: `working tree on ${branchLabel(status)}: ${parts.length > 0 ? parts.join(', ') : 'clean'}`,
    detail: { ...counts, branch: status.branch || null },
  };
}

function pickEvent({
  previous,
  status,
  commit,
  root,
  now,
}: EventInput & { previous: Partial<GitRepoState> }): GitIngestEvent | null {
  if (previous.branch !== status.branch) return branchChangeEvent({ status, commit, root, now });
  if (status.oid && previous.oid !== status.oid) return commitEvent({ status, commit, root, now });
  if (previous.signature !== status.signature) return statusChangeEvent({ status, root, now });
  return null;
}

/**
 * At most ONE event per repo per settle, and none at all on the first read of a repo.
 *
 * The first read is a BASELINE: a daemon start would otherwise announce every repo's current HEAD and
 * every uncommitted file as though they had just happened, which is history, not activity.
 *
 * The one-event rule is priority, not suppression of facts: a commit necessarily also empties the index
 * it committed, and a checkout necessarily rewrites the working tree, so publishing the consequence
 * beside the cause would put two digest lines behind one action. The state still advances on every
 * field, so the NEXT genuine working-tree change is measured against what the commit left behind.
 */
function decideGitEvents({
  previous,
  status,
  commit = null,
  root = null,
  now = 0,
}: {
  previous: Partial<GitRepoState> | null | undefined;
  status: GitStatus;
  commit?: Partial<GitCommit> | null;
  root?: string | null;
  now?: number;
}): { events: GitIngestEvent[]; next: GitRepoState } {
  const next: GitRepoState = {
    initialized: true,
    branch: status.branch,
    oid: status.oid,
    signature: status.signature,
  };
  if (!previous || previous.initialized !== true) return { events: [], next };
  const event = pickEvent({ previous, status, commit, root, now });
  return { events: event ? [event] : [], next };
}

export {
  CLEAN_SIGNATURE,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_POLL_MS,
  LOG_ARGS,
  LOG_FIELD_SEPARATOR,
  REV_PARSE_ARGS,
  SOURCE,
  STATUS_ARGS,
  createRepoState,
  decideGitEvents,
  deriveWatchDirs,
  isNoiseGitFile,
  parseCommitLine,
  parsePorcelainStatus,
  parseRevParse,
  shouldReadCommit,
  signatureOf,
};
