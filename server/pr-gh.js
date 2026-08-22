'use strict';

const { execFileAsync } = require('./child-process-safe');

// The gh/git shell-outs the PR-review poller needs, all through child-process-safe (windowsHide).
// No `git worktree` here (that stays in server/git-workspace.js behind the worktree guard); this module
// only runs `gh` and non-worktree `git` (branch/rev-parse). Every wrapper returns a normalized
// {ok,out,err,code} and never throws, so the poller can branch on ok without try/catch at each site.

async function run(cmd, args, cwd) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, encoding: 'utf8', timeout: 30000 });
    return { ok: true, out: String(stdout || '').trim(), err: '' };
  } catch (err) {
    return { ok: false, out: String(err.stdout || '').trim(), err: String(err.stderr || err.message || '') };
  }
}

function parseJson(text, fallback) {
  try { return JSON.parse(text); }
  catch { return fallback; }
}

// Pure: map a gh statusCheckRollup array to a four-way status. Exported for direct unit testing so
// the poller's merge gate can be verified without a live `gh`. Contract (critic finding #4): a PR
// with NO checks is 'none', never 'green', so a CI-less repo is never auto-merged. A rollup entry is
// either a CheckRun (status COMPLETED + conclusion) or a legacy StatusContext (state) from the Status
// API; both are normalized so Status-API-only CI is also understood.
const CHECK_CONCLUSION_OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
function normalizeCheck(c) {
  if (c.status !== undefined || c.conclusion !== undefined) {
    return {
      done: String(c.status || '').toUpperCase() === 'COMPLETED',
      ok: CHECK_CONCLUSION_OK.has(String(c.conclusion || '').toUpperCase()),
    };
  }
  const state = String(c.state || '').toUpperCase();
  return { done: state !== '' && state !== 'PENDING' && state !== 'EXPECTED', ok: state === 'SUCCESS' };
}
function classifyChecks(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (checks.length === 0) return 'none';
  const norm = checks.map(normalizeCheck);
  if (!norm.every((n) => n.done)) return 'pending';
  if (norm.every((n) => n.ok)) return 'green';
  return 'failing';
}

// Normalize a `gh pr list` row to the shape server/core/pr-review-core.js expects.
function normalizePr(row) {
  const author = row.author || {};
  return {
    number: row.number,
    headRefOid: row.headRefOid,
    headRefName: row.headRefName,
    baseRefName: row.baseRefName,
    mergeable: row.mergeable,
    title: row.title || '',
    url: row.url || '',
    isDraft: !!row.isDraft,
    isCrossRepository: !!row.isCrossRepository,
    headOwner: row.headRepositoryOwner?.login || null,
    author: {
      login: author.login || '',
      isBot: author.is_bot === true || author.isBot === true,
    },
  };
}

function createPrGh(cwd) {
  const PR_LIST_FIELDS = 'number,headRefOid,headRefName,baseRefName,mergeable,isDraft,isCrossRepository,headRepositoryOwner,author,title,url';

  return {
    async authOk() {
      return (await run('gh', ['auth', 'status'], cwd)).ok;
    },

    async repoSlug() {
      const r = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd);
      return r.ok ? r.out : null;
    },

    async listPrs() {
      const r = await run('gh', ['pr', 'list', '--state', 'open', '-L', '50', '--json', PR_LIST_FIELDS], cwd);
      if (!r.ok) return [];
      const rows = parseJson(r.out, []);
      return Array.isArray(rows) ? rows.map(normalizePr) : [];
    },

    async viewHead(n) {
      const r = await run('gh', ['pr', 'view', String(n), '--json', 'headRefOid', '-q', '.headRefOid'], cwd);
      return r.ok ? r.out : null;
    },

    // true = touches a workflow file, false = does not, null = could not determine (gh failed). The
    // caller MUST fail closed on null: an unknown file list can never clear the workflow-edit gate.
    async touchesWorkflows(n) {
      const r = await run('gh', ['pr', 'view', String(n), '--json', 'files', '-q', '.files[].path'], cwd);
      if (!r.ok) return null;
      return r.out.split(/\r?\n/).some((p) => p.trim().startsWith('.github/workflows/'));
    },

    async checksStatus(n) {
      const r = await run('gh', ['pr', 'view', String(n), '--json', 'statusCheckRollup', '-q', '.statusCheckRollup'], cwd);
      if (!r.ok) return 'none';
      return classifyChecks(parseJson(r.out, []));
    },

    async merge(n, method) {
      return run('gh', ['pr', 'merge', String(n), `--${method || 'rebase'}`], cwd);
    },

    async deleteBranch(ref) {
      if (!ref) return { ok: true, out: '', err: '' };
      return run('git', ['branch', '-D', ref], cwd);
    },
  };
}

module.exports = { createPrGh, classifyChecks, normalizePr };
