// Pure formatting/classification helpers for the Teams panel. No DOM access, so importable and
// testable without a browser (see tests/frontend-teams-format.test.js).

const STAGE_LABEL = {
  researcher: 'Researcher',
  strategist: 'Strategist',
  writer: 'Writer',
  editor: 'Editor',
  publisher: 'Publisher',
};
export const STAGE_GLYPH = { idle: '○', active: '●', done: '■', failed: '▲' };
export const VERDICT_GLYPH = { ship: '■', fix: '◆', block: '▲', failed: '▲', skipped: '○', done: '●', incomplete: '○' };
export const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
export const TZ_PRESETS = [
  'America/Denver', 'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  'UTC', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo',
];

export function key(teamId, projectId) { return `${teamId}:${projectId}`; }

export function labelFor(id) { return STAGE_LABEL[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : id); }

export function classifyVerdict(text) {
  const v = (text || '').toUpperCase();
  if (v.includes('SHIP')) return 'ship';
  if (v.includes('FIX')) return 'fix';
  if (v.includes('BLOCK')) return 'block';
  if (v.includes('FAIL') || v.includes('DIRTY') || v.includes('HALT') || v.includes('ERROR')) return 'failed';
  if (v.includes('SKIP')) return 'skipped';
  return 'done';
}

// Run folder id is "YYYY-MM-DD-weekday"; show the date + a short weekday.
export function formatRunDate(runId) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:-([a-z]+))?/i.exec(runId || '');
  if (!m) return runId || '';
  const wd = m[2] ? ` · ${m[2].charAt(0).toUpperCase()}${m[2].slice(1, 3)}` : '';
  return `${m[1]}${wd}`;
}

export function scheduleSummary(sch) {
  if (!sch || !sch.days || !sch.days.length) return '';
  const days = sch.days.map((d) => d.charAt(0).toUpperCase() + d.slice(1, 3)).join('/');
  const tz = sch.tz ? sch.tz.split('/').pop().replace(/_/g, ' ') : '';
  return `${days} ${sch.time || ''} ${tz}`.replace(/\s+/g, ' ').trim();
}

export function formatNextFire(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
}

export function isValidTz(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Editor artifact label from its filename: "drafts.md" -> "Drafts".
export function artifactLabel(file) {
  const base = String(file).replace(/\.[^.]+$/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function mmss(totalSec) {
  const s = Math.max(0, totalSec | 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function chatRoleLabel(role) {
  if (role === 'operator') return 'You';
  if (role === 'agent') return 'Team';
  return '';
}

export function failText(msg) {
  if (msg.reason === 'halt') return 'No topic available, the content calendar had nothing to cover.';
  const at = msg.stage ? ` @ ${labelFor(msg.stage)}` : '';
  if (msg.reason === 'cancelled') return `Cancelled${at}`; // user-initiated stop reads as cancelled, not failed
  const why = msg.reason ? ` · ${msg.reason}` : '';
  return `Failed${at}${why}`;
}

// Where a finished run landed: merged into the base branch, or parked on its own branch.
export function mergeNote(msg) {
  if (msg.merged) return msg.base ? ` · merged to ${msg.base}` : ' · merged';
  if (msg.branch) return ` · on ${msg.branch}`;
  return '';
}
