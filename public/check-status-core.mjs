// Pure formatting for the ADVISORY post-rebase check verdict, shared by the card chip and the review
// sidebar row so the two surfaces cannot word the same fact differently.
//
// Advisory is the whole point, and the copy has to carry it: this says what the project's own check
// thought of the worktree after an unattended rebase rewrote it. It gates nothing, so it never reads
// as a refusal or a blocker.

const STATUS_LABEL = {
  running: 'checking',
  pass: 'check green',
  fail: 'check red',
  timeout: 'check timed out',
  error: 'check errored',
};

/** The chip text, or null when there is nothing to say (no check has run for this session). */
export function checkChipText(check) {
  if (!check || typeof check.status !== 'string') return null;
  return STATUS_LABEL[check.status] || null;
}

/** 'good' | 'bad' | 'busy' | null, for a data attribute the stylesheet keys colour off. */
export function checkTone(check) {
  const status = check?.status;
  if (status === 'pass') return 'good';
  if (status === 'fail' || status === 'timeout' || status === 'error') return 'bad';
  if (status === 'running') return 'busy';
  return null;
}

function seconds(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return `${Math.max(1, Math.round(durationMs / 1000))}s`;
}

/** The longer form: what ran, what it said, and that it decides nothing. */
export function checkDetailText(check) {
  const label = checkChipText(check);
  if (!label) return '';
  const parts = [`${label}: ${check.command}`];
  const took = seconds(check.durationMs);
  if (took) parts.push(`took ${took}`);
  if (Number.isInteger(check.exitCode) && check.exitCode !== 0) parts.push(`exit ${check.exitCode}`);
  parts.push('advisory only, it does not block the merge');
  const detail = parts.join(' - ');
  const tail = typeof check.tail === 'string' ? check.tail.trim() : '';
  return tail ? `${detail}\n\n${tail}` : detail;
}
