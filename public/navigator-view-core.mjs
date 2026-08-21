// ── Navigator view: pure grouping, ordering and wording ───────
// Every decision the Navigator tab makes about WHICH sections exist, in what order, and what the counts
// read as, so navigator-panel.js is DOM only. No literal em dash, en dash or ellipsis is produced here.

export const NAVIGATOR_EMPTY_TEXT = 'No findings. Open a markdown file in a connected editor.';

// LSP counts lines from zero; editors and carbon units count from one.
export function findingLineLabel(finding) {
  const line = Number(finding?.range?.start?.line);
  if (!Number.isFinite(line) || line < 0) return 'L?';
  return `L${Math.floor(line) + 1}`;
}

function characterOf(finding) {
  const character = Number(finding?.range?.start?.character);
  return Number.isFinite(character) ? character : 0;
}

function lineOf(finding) {
  const line = Number(finding?.range?.start?.line);
  return Number.isFinite(line) ? line : 0;
}

// A file uri carries percent escapes (a Windows drive colon, a space in a path), so the tab shows the
// decoded name and keeps the raw uri for the title attribute.
export function basenameOfUri(uri) {
  const text = typeof uri === 'string' ? uri : '';
  if (!text) return '';
  const lastSlash = text.lastIndexOf('/');
  const tail = lastSlash === -1 ? text : text.slice(lastSlash + 1);
  if (!tail) return text;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

export function findingCountText(count) {
  const total = Number.isFinite(count) ? Math.max(Math.floor(count), 0) : 0;
  return total === 1 ? '1 finding' : `${total} findings`;
}

export function diagnosticsOfMessage(msg) {
  return Array.isArray(msg?.diagnostics) ? msg.diagnostics : [];
}

export function hasFindings(msg) {
  return diagnosticsOfMessage(msg).length > 0;
}

// One per-uri broadcast applied to the standing map. An empty array clears that uri rather than storing
// an empty section, so "in the map" and "has a section" stay the same statement.
export function applyFindingsMessage(findingsByUri, msg) {
  const next = new Map(findingsByUri);
  const uri = typeof msg?.uri === 'string' ? msg.uri : '';
  if (!uri) return next;
  const diagnostics = diagnosticsOfMessage(msg);
  if (diagnostics.length === 0) {
    next.delete(uri);
    return next;
  }
  next.set(uri, diagnostics);
  return next;
}

// The connect-time repair frame: a full replacement, so a uri closed while this tab was disconnected
// disappears instead of lingering.
export function applyFindingsSnapshot(msg) {
  const next = new Map();
  const documents = Array.isArray(msg?.documents) ? msg.documents : [];
  for (const document of documents) {
    const uri = typeof document?.uri === 'string' ? document.uri : '';
    const diagnostics = Array.isArray(document?.diagnostics) ? document.diagnostics : [];
    if (!uri || diagnostics.length === 0) continue;
    next.set(uri, diagnostics);
  }
  return next;
}

export function totalFindingCount(findingsByUri) {
  let total = 0;
  for (const diagnostics of findingsByUri.values()) total += diagnostics.length;
  return total;
}

// Sections by file name, because that is what the eye scans; the full uri breaks a tie between two files
// of the same name in different directories, so the order is stable across repaints.
export function findingSections(findingsByUri) {
  const sections = [];
  for (const [uri, diagnostics] of findingsByUri) {
    if (!Array.isArray(diagnostics) || diagnostics.length === 0) continue;
    sections.push({
      uri,
      name: basenameOfUri(uri) || uri,
      findings: [...diagnostics].sort((a, b) => lineOf(a) - lineOf(b) || characterOf(a) - characterOf(b)),
    });
  }
  sections.sort((a, b) => compareText(a.name, b.name) || compareText(a.uri, b.uri));
  return sections;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
