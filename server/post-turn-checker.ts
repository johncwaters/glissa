// Thin IO runner for post-turn hygiene checks. Lists a session's git-changed
// files and applies the pure rules in session/core/post-turn-rules.ts, fixing in
// place by default. Async and bounded (execFile with a timeout); it NEVER throws,
// always resolving a structured report. See .omc/plans/post-turn-checks.md.

import fs from 'node:fs';
import path from 'node:path';

import {
  applyRules,
  looksBinary,
  shouldCheckPath,
} from '../session/core/post-turn-rules.ts';
import type { RuleConfig } from '../session/core/post-turn-rules.ts';
import { execFile } from './child-process-safe.ts';

const GIT_TIMEOUT_MS = 5000;

interface FileStat {
  size: number;
  mtimeMs: number;
}

interface PostTurnDependencies {
  gitRoot?: (cwd: string | undefined) => Promise<string>;
  listChangedFiles?: (root: string) => Promise<string[]>;
  readFile?: (filePath: string) => Buffer;
  writeFile?: (filePath: string, content: string) => void;
  stat?: (filePath: string) => FileStat | null;
}

interface PostTurnCheckConfig {
  enabled: boolean;
  mode: string;
  rules: Record<string, RuleConfig>;
  include: string[];
  exclude: string[];
  maxFiles: number;
  maxFileBytes: number;
  debounceMs: number;
  runOnExit: boolean;
  reportDir: string;
}

interface PostTurnReport {
  ok: boolean;
  skipped: string | null;
  mode: string;
  root: string | null;
  filesScanned: number;
  filesFixed: number;
  findings: { file: string; rule: string; count: number }[];
  errors: { file: string | null; message: string }[];
  durationMs: number;
}

interface CheckConfigLayer {
  enabled?: unknown;
  mode?: unknown;
  maxFiles?: unknown;
  maxFileBytes?: unknown;
  debounceMs?: unknown;
  runOnExit?: unknown;
  reportDir?: unknown;
  include?: unknown;
  exclude?: unknown;
  rules?: unknown;
}

// Default config. resolveCheckConfig clones and overlays global + per-project on
// top, so the feature is ON even when config.json has no postTurnChecks key.
const DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'fix', // 'fix' | 'report'
  // `slop` is the report-only code-slop detector (session/core/slop-code-patterns.ts).
  // OFF by default: opt in per project with postTurnChecks.rules.slop = true. It never
  // rewrites content, so it is safe to enable even when mode is 'fix'.
  rules: { trailingWs: true, finalNewline: true, bom: true, slop: false },
  include: ['**/*'],
  exclude: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.git/**',
    '**/.glissa/**',
    '**/*.lock',
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
    '**/*.png',
    '**/*.jpg',
    '**/*.jpeg',
    '**/*.gif',
    '**/*.webp',
    '**/*.ico',
    '**/*.pdf',
    '**/*.zip',
    '**/*.gz',
    '**/*.woff',
    '**/*.woff2',
    '**/*.ttf',
    '**/*.eot',
  ],
  maxFiles: 200,
  maxFileBytes: 524288,
  debounceMs: 1500,
  runOnExit: false,
  reportDir: '.glissa/post-turn',
});

interface MutableCheckConfig {
  enabled: unknown;
  mode: unknown;
  rules: Record<string, unknown>;
  include: string[];
  exclude: string[];
  maxFiles: number;
  maxFileBytes: number;
  debounceMs: number;
  runOnExit: unknown;
  reportDir: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRule(val: unknown, topMode: string): RuleConfig {
  if (val === false) return { enabled: false, mode: topMode };
  if (val === true || val == null) return { enabled: true, mode: topMode };
  if (typeof val === 'object') {
    const source = val as { enabled?: unknown; mode?: unknown };
    return { enabled: source.enabled !== false, mode: typeof source.mode === 'string' ? source.mode : topMode };
  }
  return { enabled: true, mode: topMode };
}

const SCALAR_KEYS = ['enabled', 'mode', 'maxFiles', 'maxFileBytes', 'debounceMs', 'runOnExit', 'reportDir'] as const;

// Merge DEFAULTS <- global <- project. Scalars/objects: last present wins.
// Arrays (include/exclude) replace, never concat. Rules deep-merge per key.
function resolveCheckConfig(globalCfg?: unknown, projectCfg?: unknown): PostTurnCheckConfig {
  const base = JSON.parse(JSON.stringify(DEFAULTS)) as MutableCheckConfig;
  const layers = [globalCfg, projectCfg].filter((x): x is CheckConfigLayer => Boolean(x) && typeof x === 'object');
  for (const layer of layers) {
    for (const k of SCALAR_KEYS) {
      if (layer[k] != null) Object.assign(base, { [k]: layer[k] });
    }
    if (Array.isArray(layer.include)) base.include = layer.include.slice();
    if (Array.isArray(layer.exclude)) base.exclude = layer.exclude.slice();
    if (layer.rules && typeof layer.rules === 'object') {
      base.rules = Object.assign({}, base.rules, layer.rules);
    }
  }
  const topMode = base.mode === 'report' ? 'report' : 'fix';
  const rules: Record<string, RuleConfig> = {};
  for (const name of Object.keys(base.rules)) {
    rules[name] = normalizeRule(base.rules[name], topMode);
  }
  return {
    enabled: base.enabled !== false,
    mode: topMode,
    rules,
    include: base.include,
    exclude: base.exclude,
    maxFiles: base.maxFiles,
    maxFileBytes: base.maxFileBytes,
    debounceMs: base.debounceMs,
    runOnExit: !!base.runOnExit,
    reportDir: base.reportDir,
  };
}

function execGit(args: string[], cwd: string | undefined): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err: unknown, stdout: string | Buffer) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

// Resolve the worktree root for cwd. Rejects on a non-git cwd / missing git.
async function gitRoot(cwd: string | undefined): Promise<string> {
  const out = await execGit(['rev-parse', '--show-toplevel'], cwd);
  return out.toString().trim();
}

// Changed files: tracked-modified + untracked-not-ignored, deletions dropped.
// Returns repo-root-relative POSIX paths.
async function listChangedFiles(root: string): Promise<string[]> {
  const out = await execGit(
    ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '--no-renames'],
    root,
  );
  const lines = out.toString().split(/\r?\n/);
  const files: string[] = [];
  for (const ln of lines) {
    if (!ln) continue;
    const xy = ln.slice(0, 2);
    const p = ln.slice(3);
    if (!p) continue;
    if (xy.indexOf('D') !== -1) continue; // deletion in index or worktree
    files.push(p);
  }
  return files;
}

// THE RUNNER. Injectable deps (gitRoot/listChangedFiles/readFile/writeFile/stat)
// make it unit-testable without real git/fs. Never throws.
async function runPostTurnChecks({
  cwd,
  config,
  sessionId,
  deps = {},
}: {
  cwd?: string;
  config?: PostTurnCheckConfig | null;
  sessionId?: string;
  deps?: PostTurnDependencies;
} = {}): Promise<PostTurnReport> {
  const started = Date.now();
  const cfg = config || resolveCheckConfig();
  const report: PostTurnReport = {
    ok: true,
    skipped: null,
    mode: cfg.mode,
    root: null,
    filesScanned: 0,
    filesFixed: 0,
    findings: [],
    errors: [],
    durationMs: 0,
  };
  const done = (): PostTurnReport => {
    report.durationMs = Date.now() - started;
    return report;
  };

  if (!cfg.enabled) {
    report.skipped = 'disabled';
    return done();
  }

  const _gitRoot = deps.gitRoot || gitRoot;
  const _list = deps.listChangedFiles || listChangedFiles;
  const _readFile = deps.readFile || ((p: string) => fs.readFileSync(p));
  const _writeFile = deps.writeFile || ((p: string, c: string) => fs.writeFileSync(p, c));
  const _stat = deps.stat || ((p: string) => fs.statSync(p));

  let root: string;
  try {
    root = await _gitRoot(cwd);
  } catch {
    report.skipped = 'no-git';
    return done();
  }
  report.root = root;

  let files: string[];
  try {
    files = await _list(root);
  } catch (err) {
    report.skipped = 'no-git';
    report.errors.push({ file: null, message: errorMessage(err) });
    return done();
  }

  if (!files.length) {
    report.skipped = 'no-changes';
    return done();
  }

  const eligible = files
    .filter((rel) => shouldCheckPath(rel, { include: cfg.include, exclude: cfg.exclude }))
    .slice(0, cfg.maxFiles);

  let fileIndex = 0;
  for (const rel of eligible) {
    // Yield to the event loop between files (not before the first). The per-file
    // work below is synchronous (sync fs + the rule transforms), and this runner
    // shares the single Node event loop that pumps every session's PTY bytes and
    // keystrokes. Processing a large changeset in one tick stalls all of that; a
    // setImmediate break between files lets that I/O interleave. The cap+size
    // guards still bound total work.
    if (fileIndex++ > 0) await new Promise((resolve) => setImmediate(resolve));
    const abs = path.join(root, rel);
    try {
      const before = _stat(abs); // snapshot BEFORE read (mtime-race guard, PM1)
      if (!before) {
        report.errors.push({ file: rel, message: 'skipped-race' });
        continue;
      }
      if (before && before.size != null && before.size > cfg.maxFileBytes) continue;
      const buf = _readFile(abs);
      if (looksBinary(buf)) continue;
      const content = buf.toString('utf8');
      const res = applyRules(content, cfg.rules, { relPath: rel });
      report.filesScanned++;
      if (res.findings.length) {
        const counts: Record<string, number> = {};
        for (const f of res.findings) counts[f.rule] = (counts[f.rule] || 0) + 1;
        for (const [rule, count] of Object.entries(counts)) {
          report.findings.push({ file: rel, rule, count });
        }
      }
      if (cfg.mode !== 'report' && res.changed) {
        const after = _stat(abs);
        if (after && (after.mtimeMs !== before.mtimeMs || after.size !== before.size)) {
          report.errors.push({ file: rel, message: 'skipped-race' });
          continue;
        }
        _writeFile(abs, res.content);
        report.filesFixed++;
      }
    } catch (err) {
      report.errors.push({ file: rel, message: errorMessage(err) });
    }
  }

  const finalReport = done();

  // Best-effort last-run report file under the repo's .glissa area (excluded from
  // scanning by the default `**/.glissa/**`, so it never dirties the next run).
  if (sessionId) {
    try {
      const dir = path.join(root, cfg.reportDir);
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '_');
      fs.writeFileSync(path.join(dir, `${safe}.json`), JSON.stringify(finalReport, null, 2));
    } catch {
      /* best-effort */
    }
  }

  return finalReport;
}

export { gitRoot, listChangedFiles, resolveCheckConfig, runPostTurnChecks };
export type { PostTurnCheckConfig, PostTurnDependencies, PostTurnReport };
