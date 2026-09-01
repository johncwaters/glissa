import fs from 'node:fs';
import path from 'node:path';

import { glissaHomeDir } from './config-store.ts';

const DEFAULT_POSTHOG_REPORT_DIR = path.join(glissaHomeDir(), 'posthog-reports');
const POSTHOG_REPORT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface ReportCandidate {
  format: string;
  reportPath: string;
}

type ResolvedReportPath =
  | { ok: false; reason: string }
  | { ok: true; issueId: string; reportDir: string; candidates: ReportCandidate[] };

interface ReadReportResult {
  ok: boolean;
  found: boolean;
  issueId: string | null;
  format?: string;
  content?: string;
  error?: string;
  message?: string;
}

// Same traversal guard as control-handlers.ts confinePath: resolve under the base dir and refuse a
// result that escapes it. Kept locally because control-handlers exports only its registration entry.
function confinePath(baseDir: string, ...segments: string[]): string | null {
  const abs = path.resolve(baseDir, ...segments);
  const rel = path.relative(baseDir, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
}

function resolvePosthogReportPath(
  issueId: unknown,
  reportDir: string = DEFAULT_POSTHOG_REPORT_DIR,
): ResolvedReportPath {
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

async function readPosthogReport(
  issueId: unknown,
  { reportDir = DEFAULT_POSTHOG_REPORT_DIR }: { reportDir?: string } = {},
): Promise<ReadReportResult> {
  const resolved = resolvePosthogReportPath(issueId, reportDir);
  if (resolved.ok === false) {
    return { ok: false, found: false, issueId: typeof issueId === 'string' ? issueId : null, error: resolved.reason };
  }

  for (const candidate of resolved.candidates) {
    try {
      const content = await fs.promises.readFile(candidate.reportPath, 'utf8');
      return { ok: true, found: true, issueId: resolved.issueId, format: candidate.format, content };
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'ENOENT') continue;
      // Generic message on purpose: fs error strings carry the absolute server path, which does not
      // belong on a paired remote client.
      return { ok: false, found: false, issueId: resolved.issueId, error: 'Could not read report' };
    }
  }

  return { ok: true, found: false, issueId: resolved.issueId, message: 'Report not found' };
}

export {
  DEFAULT_POSTHOG_REPORT_DIR,
  readPosthogReport,
  resolvePosthogReportPath,
};
export type { ReadReportResult, ResolvedReportPath };
