import { execFileAsync } from './child-process-safe.ts';


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
