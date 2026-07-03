'use strict';

// Thin IO runner for post-turn hygiene checks. Lists a session's git-changed
// files and applies the pure rules in session/core/post-turn-rules.js, fixing in
// place by default. Async and bounded (execFile with a timeout); it NEVER throws,
// always resolving a structured report. See .omc/plans/post-turn-checks.md.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('./child-process-safe');
const {
  applyRules,
  shouldCheckPath,
  looksBinary,
} = require('../session/core/post-turn-rules');

const GIT_TIMEOUT_MS = 5000;

// Default config. resolveCheckConfig clones and overlays global + per-project on
// top, so the feature is ON even when config.json has no postTurnChecks key.
const DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'fix', // 'fix' | 'report'
  // `slop` is the report-only code-slop detector (session/core/slop-code-patterns.js).
  // OFF by default: opt in per project with postTurnChecks.rules.slop = true. It never
  // rewrites content, so it is safe to enable even when mode is 'fix'.
  rules: { dashes: true, trailingWs: true, finalNewline: true, bom: true, slop: false },
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

function normalizeRule(val, topMode) {
  if (val === false) return { enabled: false, mode: topMode };
  if (val === true || val == null) return { enabled: true, mode: topMode };
  if (typeof val === 'object') {
    return { enabled: val.enabled !== false, mode: val.mode || topMode };
  }
  return { enabled: true, mode: topMode };
}

// Merge DEFAULTS <- global <- project. Scalars/objects: last present wins.
// Arrays (include/exclude) replace, never concat. Rules deep-merge per key.
function resolveCheckConfig(globalCfg, projectCfg) {
  const base = JSON.parse(JSON.stringify(DEFAULTS));
  const layers = [globalCfg, projectCfg].filter((x) => x && typeof x === 'object');
  for (const layer of layers) {
    for (const k of ['enabled', 'mode', 'maxFiles', 'maxFileBytes', 'debounceMs', 'runOnExit', 'reportDir']) {
      if (layer[k] != null) base[k] = layer[k];
    }
    if (Array.isArray(layer.include)) base.include = layer.include.slice();
    if (Array.isArray(layer.exclude)) base.exclude = layer.exclude.slice();
    if (layer.rules && typeof layer.rules === 'object') {
      base.rules = Object.assign({}, base.rules, layer.rules);
    }
  }
  const topMode = base.mode === 'report' ? 'report' : 'fix';
  const rules = {};
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

function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

// Resolve the worktree root for cwd. Rejects on a non-git cwd / missing git.
async function gitRoot(cwd) {
  const out = await execGit(['rev-parse', '--show-toplevel'], cwd);
  return out.toString().trim();
}

// Changed files: tracked-modified + untracked-not-ignored, deletions dropped.
// Returns repo-root-relative POSIX paths.
async function listChangedFiles(root) {
  const out = await execGit(
    ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '--no-renames'],
    root,
  );
  const lines = out.toString().split(/\r?\n/);
  const files = [];
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
async function runPostTurnChecks({ cwd, config, sessionId, deps = {} } = {}) {
  const started = Date.now();
  const cfg = config || resolveCheckConfig();
  const report = {
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
  const done = () => {
    report.durationMs = Date.now() - started;
    return report;
  };

  if (!cfg.enabled) {
    report.skipped = 'disabled';
    return done();
  }

  const _gitRoot = deps.gitRoot || gitRoot;
  const _list = deps.listChangedFiles || listChangedFiles;
  const _readFile = deps.readFile || ((p) => fs.readFileSync(p));
  const _writeFile = deps.writeFile || ((p, c) => fs.writeFileSync(p, c));
  const _stat = deps.stat || ((p) => fs.statSync(p));

  let root;
  try {
    root = await _gitRoot(cwd);
  } catch {
    report.skipped = 'no-git';
    return done();
  }
  report.root = root;

  let files;
  try {
    files = await _list(root);
  } catch (err) {
    report.skipped = 'no-git';
    report.errors.push({ file: null, message: err.message });
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
      if (before && before.size != null && before.size > cfg.maxFileBytes) continue;
      const buf = _readFile(abs);
      if (looksBinary(buf)) continue;
      const content = buf.toString('utf8');
      const res = applyRules(content, cfg.rules, { relPath: rel });
      report.filesScanned++;
      if (res.findings.length) {
        const counts = {};
        for (const f of res.findings) counts[f.rule] = (counts[f.rule] || 0) + 1;
        for (const rule of Object.keys(counts)) {
          report.findings.push({ file: rel, rule, count: counts[rule] });
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
      report.errors.push({ file: rel, message: err.message });
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
      fs.writeFileSync(path.join(dir, safe + '.json'), JSON.stringify(finalReport, null, 2));
    } catch {
      /* best-effort */
    }
  }

  return finalReport;
}

module.exports = { runPostTurnChecks, resolveCheckConfig, listChangedFiles, gitRoot, DEFAULTS };
