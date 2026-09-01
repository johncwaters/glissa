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
      if (line === '') continue;
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

export function shouldDropDiffCache(prevStatus: string | null | undefined, nextStatus: string | null | undefined) {
  if (nextStatus === 'merged' || nextStatus === 'none') return true;
  return prevStatus === 'parked' && nextStatus === 'pending-review';
}

export function summarizeFiles(files: readonly Pick<DiffFile, 'added' | 'removed'>[] | null | undefined) {
  let added = 0, removed = 0;
  for (const f of (files || [])) { added += f.added || 0; removed += f.removed || 0; }
  return { files: (files || []).length, added, removed };
}
