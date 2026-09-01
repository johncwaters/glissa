// Cross-worktree Claude conversation discovery.
//
// Claude Code stores each conversation as a JSONL transcript at
//   <claudeHome>/projects/<encoded-cwd>/<session-uuid>.jsonl
// where the directory name is the absolute cwd with EVERY non-alphanumeric char
// turned into a single '-'. Verified against the on-disk layout, e.g.
//   C:\Users\johnw\Projects\glissa                     -> C--Users-johnw-Projects-glissa
//   C:\Users\johnw\Projects\.glissa-worktrees\glissa-x -> C--Users-johnw-Projects--glissa-worktrees-glissa-x
// Because every separator collapses to '-', a forward-slash path (as `git
// worktree list` prints on Windows) and a backslash path encode to the SAME dir,
// so we never normalize slashes.
//
// WHY this module exists: each Glissa session runs in its own linked git
// worktree, and Claude silos transcripts per-cwd, so a conversation started in
// worktree A lives under A's project dir, invisible to a session spawned in
// worktree B. Claude's own `--resume <id>` DOES resolve a session across all
// worktrees of one repo (proven), but it has no UI to LIST them. This module is
// that listing: it walks the repo's worktree set, locates each worktree's
// project dir, and reads light metadata (title, cwd, branch, mtime) so the
// dashboard can offer "resume this conversation here". Resuming itself is just
// `claude --resume <id>` in the target worktree (see sessions.js).
//
// Everything here is a one-shot, user-initiated cold path (the operator clicked
// "Resume" on a card), so synchronous fs reads are fine; the only subprocess
// (`git worktree list`) is async so a large repo never stalls the event loop.

import path from 'node:path';

// The injected fs seam: the exact synchronous surface this core reads through, so it imports no node:fs.
interface TranscriptFsApi {
  openSync: (path: string, flags: string) => number;
  fstatSync: (fd: number) => { size: number };
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  closeSync: (fd: number) => void;
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { isFile: () => boolean; mtimeMs: number };
}

type GitRunner = (args: string[], cwd: string) => Promise<string | Buffer>;

interface TranscriptMeta {
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
}

interface ConversationEntry {
  id: string;
  title: string;
  cwd: string;
  worktreePath: string;
  worktreeName: string;
  gitBranch: string | null;
  mtime: number;
}

interface ListConversationsOptions {
  repoPath?: string;
  projectsDir: string;
  git: GitRunner;
  fsMod: TranscriptFsApi;
  limit?: number;
}

// Reproduce Claude Code's project-dir encoding: every non-alphanumeric char -> '-'.
// Drive-letter case is preserved (only non-alnum is touched), matching the store.
function encodeProjectDir(cwd: unknown): string {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

// Root of Claude Code's per-project transcript store. CLAUDE_CONFIG_DIR relocates
// the whole ~/.claude home; honor it so a relocated config still resolves.
function claudeProjectsDir(
  env: Record<string, string | undefined> | null | undefined,
  homeDir: string,
): string {
  const override = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  const home = override || path.join(homeDir, '.claude');
  return path.join(home, 'projects');
}

// Every working tree attached to `repoPath`'s repository (the main checkout plus
// every linked worktree), as printed by `git worktree list --porcelain`. Falls
// back to just [repoPath] for a non-git path or any git failure.
async function listRepoWorktreePaths(repoPath: string, git: GitRunner): Promise<string[]> {
  let out: string | Buffer;
  try {
    out = await git(['worktree', 'list', '--porcelain'], repoPath);
  } catch {
    return [repoPath];
  }
  const paths: string[] = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^worktree\s+(.+)$/.exec(line);
    if (m) paths.push(m[1].trim());
  }
  return paths.length ? paths : [repoPath];
}

// Pull a human-readable title out of a user message's `content` (string, or an
// array of content blocks). Returns '' when there is no usable text.
function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

// Turn the first user turn into a one-line label: prefer a slash-command's
// <command-args>, strip XML-ish wrappers (command-message/name, system-reminder),
// collapse whitespace, and truncate. Keeps the picker readable when the first
// turn is an OMC command envelope rather than plain prose.
function stripCommandEnvelope(raw: string): string {
  const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/i.exec(raw);
  if (argsMatch?.[1].trim()) return argsMatch[1];
  return raw
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, ' ')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, ' ')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function cleanTitle(raw: unknown, max = 100): string {
  const s = stripCommandEnvelope(String(raw || '')).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s;
}

// Read up to maxBytes from the head of a transcript and return its COMPLETE
// lines. The first user turn and the cwd/branch metadata sit near the top, so a
// bounded read avoids loading multi-MB transcripts in full. A trailing partial
// line (when truncated) is dropped so JSON.parse never sees a half line.
function readHeadLines(filePath: string, fsMod: TranscriptFsApi, maxBytes = 262144): string[] {
  const fd = fsMod.openSync(filePath, 'r');
  try {
    const size = fsMod.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    if (len === 0) return [];
    const buf = Buffer.alloc(len);
    fsMod.readSync(fd, buf, 0, len, 0);
    let text = buf.toString('utf8');
    if (size > maxBytes) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl !== -1) text = text.slice(0, lastNl);
    }
    return text.split(/\r?\n/).filter(Boolean);
  } finally {
    fsMod.closeSync(fd);
  }
}

// Extract { cwd, gitBranch, title } from a transcript's head lines.
function extractMeta(lines: readonly string[]): TranscriptMeta {
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let title: string | null = null;
  for (const line of lines) {
    let o: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      continue;
    }
    if (!cwd && o && typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
    if (!gitBranch && o && typeof o.gitBranch === 'string' && o.gitBranch) gitBranch = o.gitBranch;
    if (!title && o && o.type === 'user' && o.message) {
      const message = o.message as { content?: unknown };
      const text = cleanTitle(userText(message.content));
      if (text) title = text;
    }
    if (cwd && title && gitBranch) break;
  }
  return { cwd, gitBranch, title };
}

// List resumable Claude conversations for a repo, across the main checkout and
// every linked worktree, newest-first. De-duplicated by session id (a session
// that Claude migrated/forked can surface under two project dirs; keep newest).
//
//   listRepoConversations({ repoPath, projectsDir, git, fsMod, limit? })
//     -> [{ id, title, cwd, worktreePath, worktreeName, gitBranch, mtime }]
async function listRepoConversations({
  repoPath,
  projectsDir,
  git,
  fsMod,
  limit = 60,
}: ListConversationsOptions): Promise<ConversationEntry[]> {
  if (!repoPath) return [];
  const worktreePaths = await listRepoWorktreePaths(repoPath, git);

  // Pass 1 (cheap): stat every transcript and de-dup by id (newest copy wins). No file BODIES are read
  // here, so cost is one stat per transcript regardless of how many the repo has accumulated.
  const byId = new Map<string, { id: string; full: string; worktreePath: string; mtime: number }>();
  const seenDirs = new Set<string>();
  for (const wt of worktreePaths) {
    const dirName = encodeProjectDir(wt);
    if (seenDirs.has(dirName)) continue;
    seenDirs.add(dirName);
    const projDir = path.join(projectsDir, dirName);
    let entries: string[];
    try { entries = fsMod.readdirSync(projDir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(projDir, name);
      let stat: { isFile: () => boolean; mtimeMs: number };
      try { stat = fsMod.statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      const id = name.slice(0, -('.jsonl'.length));
      const cand = { id, full, worktreePath: wt, mtime: stat.mtimeMs };
      const prev = byId.get(id);
      if (!prev || cand.mtime > prev.mtime) byId.set(id, cand);
    }
  }

  // Sort newest-first and keep only `limit` BEFORE the bounded head-read below, so the (up to 256KB)
  // body read runs at most `limit` times even on a repo with thousands of transcripts.
  const top = [...byId.values()].sort((a, b) => b.mtime - a.mtime).slice(0, limit);

  // Pass 2 (bounded): read each survivor's head for the title/cwd/branch shown in the picker.
  return top.map((c) => {
    let meta: TranscriptMeta = { cwd: null, gitBranch: null, title: null };
    try { meta = extractMeta(readHeadLines(c.full, fsMod)); } catch { /* unreadable -> minimal entry */ }
    return {
      id: c.id,
      title: meta.title || '(no messages yet)',
      cwd: meta.cwd || c.worktreePath,
      worktreePath: c.worktreePath,
      worktreeName: path.basename(c.worktreePath),
      gitBranch: meta.gitBranch || null,
      mtime: c.mtime,
    };
  });
}

export {
  claudeProjectsDir,
  encodeProjectDir,
  listRepoWorktreePaths,
  listRepoConversations,
  cleanTitle, // exported for unit tests
};
export type { ConversationEntry, GitRunner, ListConversationsOptions, TranscriptFsApi, TranscriptMeta };
