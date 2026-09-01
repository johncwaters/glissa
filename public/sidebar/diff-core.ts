// Pure unified-diff parsing for the review sidebar's rendered diff. No DOM, no dependencies; mirrors
// the other pure cores (naming-core.mjs, webgl-core.mjs) so it is unit-testable under node --test.
// The sidebar's DOM module (review-sidebar.js) turns these data structures into colored markup.

// Parse a `git diff` (unified) blob into an array of file sections:
//   { path, oldPath, status, added, removed, binary, hunks: [{ header, lines: [{type, text}] }] }
// status is one of 'added' | 'deleted' | 'renamed' | 'modified'. Line type is
// 'add' | 'del' | 'context' | 'meta' (a "\ No newline at end of file" marker). added/removed are the
// EXACT per-file counts derived from the hunk bodies (not the scaled --stat bars). Tolerates CRLF,
// an empty input (returns []), new files (git add -N / "new file mode" / "--- /dev/null"), deletes,
// renames, and binary files.
export interface DiffLine {
  type: string;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: string;
  added: number;
  removed: number;
  binary: boolean;
  hunks: DiffHunk[];
}

export function parseUnifiedDiff(diff: string | null | undefined): DiffFile[] {
  const files: DiffFile[] = [];
  if (!diff) return files;
  const lines = String(diff).split(/\r?\n/);
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  const startFile = (header: string) => {
    const file: DiffFile = { path: '', oldPath: null, status: 'modified', added: 0, removed: 0, binary: false, hunks: [] };
    files.push(file);
    hunk = null;
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
    if (m) { file.oldPath = m[1] ?? null; file.path = m[2] ?? ''; }
    return file;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) { cur = startFile(line); continue; }
    if (!cur) {
      // Tolerate a diff with no "diff --git" prefix (e.g. a single-file `git diff`): synthesize a file.
      if (!line.startsWith('--- ') && !line.startsWith('@@')) continue;
      cur = startFile('diff --git a/ b/');
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) { cur.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue; }
    if (line.startsWith('rename from ')) { cur.oldPath = line.slice('rename from '.length); cur.status = 'renamed'; continue; }
    if (line.startsWith('rename to ')) { cur.path = line.slice('rename to '.length); cur.status = 'renamed'; continue; }
    if (line.startsWith('Binary files')) { cur.binary = true; continue; }
    if (line.startsWith('index ') || line.startsWith('similarity index')
        || line.startsWith('dissimilarity index') || line.startsWith('old mode') || line.startsWith('new mode')) {
      continue;
    }
    if (line.startsWith('--- ')) {
      if (line === '--- /dev/null') { cur.status = 'added'; continue; }
      if (!cur.path) { const p = line.slice(4).replace(/^a\//, ''); if (p && p !== '/dev/null') cur.oldPath = cur.oldPath || p; }
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (line === '+++ /dev/null') { cur.status = 'deleted'; continue; }
      if (!cur.path) { const p = line.slice(4).replace(/^b\//, ''); if (p && p !== '/dev/null') cur.path = p; }
      continue;
    }
    if (line.startsWith('@@')) {
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      if (line === '') continue; // trailing split artifact / blank separator (a real blank line is " ")
      const c = line[0];
      if (c === '+') { hunk.lines.push({ type: 'add', text: line.slice(1) }); cur.added++; continue; }
      if (c === '-') { hunk.lines.push({ type: 'del', text: line.slice(1) }); cur.removed++; continue; }
      if (c === '\\') { hunk.lines.push({ type: 'meta', text: line.slice(1).trim() }); continue; }
      hunk.lines.push({ type: 'context', text: c === ' ' ? line.slice(1) : line });
    }
  }
  for (const f of files) { if (!f.path) f.path = f.oldPath || '(unknown)'; }
  return files;
}

// Pure cache-staleness decision for the sidebar's per-session diff cache. True when a merge-status
// transition makes the cached diff payload stale and it must be refetched: after a merge or discard
// ('merged'/'none' the worktree is gone), and when a parked merge is handed back as mergeable
// ('parked' -> 'pending-review': the resolve rebase moved HEAD, so the cached hasCommits is stale and
// would leave the re-enabled Merge button disabled). False otherwise, including 'parked' -> 'merging'
// (diff stays visible mid-merge) and a first surface into 'pending-review' (nothing cached to drop).
export function shouldDropDiffCache(prevStatus: string | null | undefined, nextStatus: string | null | undefined) {
  if (nextStatus === 'merged' || nextStatus === 'none') return true;
  return prevStatus === 'parked' && nextStatus === 'pending-review';
}

// Roll a parsed file list up into a one-line summary for the sidebar header.
export function summarizeFiles(files: readonly Pick<DiffFile, 'added' | 'removed'>[] | null | undefined) {
  let added = 0, removed = 0;
  for (const f of (files || [])) { added += f.added || 0; removed += f.removed || 0; }
  return { files: (files || []).length, added, removed };
}
