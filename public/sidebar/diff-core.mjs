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
export function parseUnifiedDiff(diff) {
  const files = [];
  if (!diff) return files;
  const lines = String(diff).split(/\r?\n/);
  let cur = null;
  let hunk = null;

  const startFile = (header) => {
    cur = { path: '', oldPath: null, status: 'modified', added: 0, removed: 0, binary: false, hunks: [] };
    files.push(cur);
    hunk = null;
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
    if (m) { cur.oldPath = m[1]; cur.path = m[2]; }
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) { startFile(line); continue; }
    if (!cur) {
      // Tolerate a diff with no "diff --git" prefix (e.g. a single-file `git diff`): synthesize a file.
      if (line.startsWith('--- ') || line.startsWith('@@')) startFile('diff --git a/ b/');
      else continue;
    }
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
      if (line === '--- /dev/null') cur.status = 'added';
      else if (!cur.path) { const p = line.slice(4).replace(/^a\//, ''); if (p && p !== '/dev/null') cur.oldPath = cur.oldPath || p; }
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (line === '+++ /dev/null') cur.status = 'deleted';
      else if (!cur.path) { const p = line.slice(4).replace(/^b\//, ''); if (p && p !== '/dev/null') cur.path = p; }
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
      if (c === '+') { hunk.lines.push({ type: 'add', text: line.slice(1) }); cur.added++; }
      else if (c === '-') { hunk.lines.push({ type: 'del', text: line.slice(1) }); cur.removed++; }
      else if (c === '\\') { hunk.lines.push({ type: 'meta', text: line.slice(1).trim() }); }
      else { hunk.lines.push({ type: 'context', text: c === ' ' ? line.slice(1) : line }); }
    }
  }
  for (const f of files) { if (!f.path) f.path = f.oldPath || '(unknown)'; }
  return files;
}

// Roll a parsed file list up into a one-line summary for the sidebar header.
export function summarizeFiles(files) {
  let added = 0, removed = 0;
  for (const f of (files || [])) { added += f.added || 0; removed += f.removed || 0; }
  return { files: (files || []).length, added, removed };
}
