'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_POSTHOG_REPORT_DIR = path.join(os.homedir(), '.glissa', 'posthog-reports');
const POSTHOG_REPORT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Same traversal guard as control-handlers.js confinePath: resolve under the base dir and refuse a
// result that escapes it. Kept locally because control-handlers exports only its registration entry.
function confinePath(baseDir, ...segments) {
  const abs = path.resolve(baseDir, ...segments);
  const rel = path.relative(baseDir, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
}

function resolvePosthogReportPath(issueId, reportDir = DEFAULT_POSTHOG_REPORT_DIR) {
  const rawIssueId = typeof issueId === 'string' ? issueId.trim() : '';
  if (!POSTHOG_REPORT_ID_RE.test(rawIssueId)) {
    return { ok: false, reason: 'Invalid issue id' };
  }

  const resolvedReportDir = path.resolve(reportDir);
  const resolvedReportPath = confinePath(resolvedReportDir, `${rawIssueId}.md`);
  if (!resolvedReportPath) {
    return { ok: false, reason: 'Invalid report path' };
  }

  return { ok: true, issueId: rawIssueId, reportDir: resolvedReportDir, reportPath: resolvedReportPath };
}

async function readPosthogReport(issueId, { reportDir = DEFAULT_POSTHOG_REPORT_DIR } = {}) {
  const resolved = resolvePosthogReportPath(issueId, reportDir);
  if (!resolved.ok) {
    return { ok: false, found: false, issueId: typeof issueId === 'string' ? issueId : null, error: resolved.reason };
  }

  try {
    const content = await fs.promises.readFile(resolved.reportPath, 'utf8');
    return { ok: true, found: true, issueId: resolved.issueId, content };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: true, found: false, issueId: resolved.issueId, message: 'Report not found' };
    }
    // Generic message on purpose: fs error strings carry the absolute server path, which does not
    // belong on a paired remote client.
    return { ok: false, found: false, issueId: resolved.issueId, error: 'Could not read report' };
  }
}

module.exports = {
  DEFAULT_POSTHOG_REPORT_DIR,
  readPosthogReport,
  resolvePosthogReportPath,
};
