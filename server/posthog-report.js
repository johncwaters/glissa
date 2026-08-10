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
  const htmlReportPath = confinePath(resolvedReportDir, `${rawIssueId}.html`);
  const markdownReportPath = confinePath(resolvedReportDir, `${rawIssueId}.md`);
  if (!htmlReportPath || !markdownReportPath) {
    return { ok: false, reason: 'Invalid report path' };
  }

  return {
    ok: true,
    issueId: rawIssueId,
    reportDir: resolvedReportDir,
    candidates: [
      { format: 'html', reportPath: htmlReportPath },
      { format: 'markdown', reportPath: markdownReportPath },
    ],
  };
}

async function readPosthogReport(issueId, { reportDir = DEFAULT_POSTHOG_REPORT_DIR } = {}) {
  const resolved = resolvePosthogReportPath(issueId, reportDir);
  if (!resolved.ok) {
    return { ok: false, found: false, issueId: typeof issueId === 'string' ? issueId : null, error: resolved.reason };
  }

  for (const candidate of resolved.candidates) {
    try {
      const content = await fs.promises.readFile(candidate.reportPath, 'utf8');
      return { ok: true, found: true, issueId: resolved.issueId, format: candidate.format, content };
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      // Generic message on purpose: fs error strings carry the absolute server path, which does not
      // belong on a paired remote client.
      return { ok: false, found: false, issueId: resolved.issueId, error: 'Could not read report' };
    }
  }

  return { ok: true, found: false, issueId: resolved.issueId, message: 'Report not found' };
}

module.exports = {
  DEFAULT_POSTHOG_REPORT_DIR,
  readPosthogReport,
  resolvePosthogReportPath,
};
