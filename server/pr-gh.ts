import { execFileAsync } from './child-process-safe.ts';

// The gh/git shell-outs the PR-review poller needs, all through child-process-safe (windowsHide).
// No `git worktree` here (that stays in server/git-workspace.ts behind the worktree guard); this module
// only runs `gh` and non-worktree `git` (branch/rev-parse). Every wrapper returns a normalized
// {ok,out,err} and never throws, so the poller can branch on ok without try/catch at each site.

interface CommandResult {
  ok: boolean;
  out: string;
  err: string;
}

type ChecksStatus = 'none' | 'pending' | 'green' | 'failing';

interface RollupEntry {
  status?: unknown;
  conclusion?: unknown;
  state?: unknown;
}

interface PrListRow {
  number: number;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  title?: string;
  url?: string;
  isDraft?: boolean;
  isCrossRepository?: boolean;
  headRepositoryOwner?: { login?: string } | null;
  author?: { login?: string; is_bot?: unknown; isBot?: unknown } | null;
}

interface NormalizedPr {
  number: number;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  title: string;
  url: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  headOwner: string | null;
  author: { login: string; isBot: boolean };
}

interface PrGh {
  authOk(): Promise<boolean>;
  repoSlug(): Promise<string | null>;
  listPrs(): Promise<NormalizedPr[]>;
  viewHead(n: number | string): Promise<string | null>;
  touchesWorkflows(n: number | string): Promise<boolean | null>;
  checksStatus(n: number | string): Promise<ChecksStatus>;
  merge(n: number | string, method?: string | null): Promise<CommandResult>;
  deleteBranch(ref: string | null | undefined): Promise<CommandResult>;
}

async function run(cmd: string, args: string[], cwd: string): Promise<CommandResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, encoding: 'utf8', timeout: 30000 });
    return { ok: true, out: String(stdout || '').trim(), err: '' };
  } catch (err) {
    const failure = (err ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return { ok: false, out: String(failure.stdout || '').trim(), err: String(failure.stderr || failure.message || '') };
  }
}

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; }
  catch { return fallback; }
}

// Pure: map a gh statusCheckRollup array to a four-way status. Exported for direct unit testing so
// the poller's merge gate can be verified without a live `gh`. Contract (critic finding #4): a PR
// with NO checks is 'none', never 'green', so a CI-less repo is never auto-merged. A rollup entry is
// either a CheckRun (status COMPLETED + conclusion) or a legacy StatusContext (state) from the Status
// API; both are normalized so Status-API-only CI is also understood.
const CHECK_CONCLUSION_OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
function normalizeCheck(c: RollupEntry): { done: boolean; ok: boolean } {
  if (c.status !== undefined || c.conclusion !== undefined) {
    return {
      done: String(c.status || '').toUpperCase() === 'COMPLETED',
      ok: CHECK_CONCLUSION_OK.has(String(c.conclusion || '').toUpperCase()),
    };
  }
  const state = String(c.state || '').toUpperCase();
  return { done: state !== '' && state !== 'PENDING' && state !== 'EXPECTED', ok: state === 'SUCCESS' };
}

function classifyChecks(rollup: unknown): ChecksStatus {
  const checks: RollupEntry[] = Array.isArray(rollup) ? rollup : [];
  if (checks.length === 0) return 'none';
  const norm = checks.map(normalizeCheck);
  if (!norm.every((n) => n.done)) return 'pending';
  if (norm.every((n) => n.ok)) return 'green';
  return 'failing';
}

// Normalize a `gh pr list` row to the shape server/core/pr-review-core.ts expects.
function normalizePr(row: PrListRow): NormalizedPr {
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

function createPrGh(cwd: string): PrGh {
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
      const rows = parseJson<PrListRow[]>(r.out, []);
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
      return classifyChecks(parseJson<RollupEntry[]>(r.out, []));
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

export { classifyChecks, createPrGh, normalizePr };
export type { ChecksStatus, CommandResult, NormalizedPr, PrGh };
