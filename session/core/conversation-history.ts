import path from 'node:path';

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

function encodeProjectDir(cwd: unknown): string {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function claudeProjectsDir(
  env: Record<string, string | undefined> | null | undefined,
  homeDir: string,
): string {
  const override = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  const home = override || path.join(homeDir, '.claude');
  return path.join(home, 'projects');
}

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

async function listRepoConversations({
  repoPath,
  projectsDir,
  git,
  fsMod,
  limit = 60,
}: ListConversationsOptions): Promise<ConversationEntry[]> {
  if (!repoPath) return [];
  const worktreePaths = await listRepoWorktreePaths(repoPath, git);

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

  const top = [...byId.values()].sort((a, b) => b.mtime - a.mtime).slice(0, limit);

  return top.map((c) => {
    let meta: TranscriptMeta = { cwd: null, gitBranch: null, title: null };
    try { meta = extractMeta(readHeadLines(c.full, fsMod)); } catch {  }
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
  cleanTitle,
};
export type { ConversationEntry, GitRunner, ListConversationsOptions, TranscriptFsApi, TranscriptMeta };
