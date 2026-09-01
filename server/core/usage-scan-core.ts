import path from 'node:path';
import { stringOrNull } from './usage-number-core.ts';

export interface FileReadCursor {
  offset?: number;
  size?: number;
  mtimeMs?: number;
}

export interface VendorRoot {
  dir: string;
  kind: 'active' | 'archived' | 'flat';
  home: string;
}

function decideFileRead(
  prior: FileReadCursor | null | undefined,
  stat: { size?: unknown; mtimeMs?: unknown } | null | undefined,
): { action: 'restart' | 'skip' | 'append'; readFrom: number } {
  if (!prior) return { action: 'restart', readFrom: 0 };
  if (!stat || typeof stat.size !== 'number') return { action: 'skip', readFrom: prior.offset || 0 };
  if (stat.size < (prior.size || 0)) return { action: 'restart', readFrom: 0 };
  if (stat.size < (prior.offset || 0)) return { action: 'restart', readFrom: 0 };
  if (stat.size === (prior.offset || 0) && stat.mtimeMs === prior.mtimeMs) return { action: 'skip', readFrom: prior.offset || 0 };
  return { action: 'append', readFrom: prior.offset || 0 };
}

function splitLines(carry: string | null | undefined, chunkText: string | null | undefined): { lines: string[]; carry: string } {
  const text = `${carry || ''}${chunkText || ''}`;
  const lines = text.split(/\r?\n/);
  const nextCarry = text.endsWith('\n') || text.endsWith('\r\n') ? '' : lines.pop();
  return { lines: lines.filter((line) => line.length > 0), carry: nextCarry || '' };
}

function resolveProjectsDirs(
  env: NodeJS.ProcessEnv = process.env,
  extraDirs: string[] = [],
  isDirectory?: (candidate: string) => boolean,
  homeDir: string | null = null,
): string[] {
  if (typeof isDirectory !== 'function') throw new TypeError('resolveProjectsDirs requires an isDirectory function');
  const surviving = projectDirCandidates(env, extraDirs, homeDir).filter(isDirectory);
  if (!configDirOverride(env)) return surviving;
  const overrideSurvivors = projectDirCandidates(env, [], homeDir).filter(isDirectory);
  if (overrideSurvivors.length === 0) throw new Error('CLAUDE_CONFIG_DIR is set but no projects directory exists');
  return surviving;
}

function projectDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
  extraDirs: string[] = [],
  homeDir: string | null = null,
): string[] {
  const override = configDirOverride(env);
  const extraHomes = normalizeHomeCandidates(extraDirs, env, homeDir);
  if (override) {
    const overrideHomes = normalizeHomeCandidates(override.split(','), env, homeDir);
    return uniqueStrings([...projectsDirsFromHomes(overrideHomes), ...projectsDirsFromHomes(extraHomes)]);
  }

  const resolvedHomeDir = resolveHomeDir(env, homeDir);
  if (!resolvedHomeDir) return uniqueStrings(projectsDirsFromHomes(extraHomes));
  const xdgConfigHome = stringOrNull(env.XDG_CONFIG_HOME) || path.join(resolvedHomeDir, '.config');
  const defaultHomes = [path.join(xdgConfigHome, 'claude'), path.join(resolvedHomeDir, '.claude')];
  return uniqueStrings([...projectsDirsFromHomes(defaultHomes), ...projectsDirsFromHomes(extraHomes)]);
}

function configDirOverride(env: NodeJS.ProcessEnv): string {
  const override = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : '';
  return override.trim();
}

function projectsDirsFromHomes(homes: string[]): string[] {
  const projectsDirs: string[] = [];
  for (const candidate of homes) {
    const home = path.basename(candidate) === 'projects' ? path.dirname(candidate) : candidate;
    const projectsDir = path.join(home, 'projects');
    projectsDirs.push(projectsDir);
  }
  return projectsDirs;
}

function normalizeHomeCandidates(candidates: unknown, env: NodeJS.ProcessEnv, homeDir: string | null): string[] {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((candidate) => expandTilde(String(candidate || '').trim(), env, homeDir))
    .filter(Boolean);
}

function expandTilde(candidate: string, env: NodeJS.ProcessEnv, homeDir: string | null): string {
  if (!candidate.startsWith('~')) return candidate;
  const home = resolveHomeDir(env, homeDir);
  if (!home) return '';
  if (candidate === '~') return home;
  if (!candidate.startsWith(`~${path.sep}`) && !candidate.startsWith('~/')) return candidate;
  return path.join(home, candidate.slice(2));
}

function resolveHomeDir(env: NodeJS.ProcessEnv, homeDir: string | null): string | null {
  return stringOrNull(env.HOME) || stringOrNull(env.USERPROFILE) || homeDir;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

// ── Other vendors ──
// Codex and Grok keep their transcripts in their own homes, in their own layouts. These build the
// CANDIDATE roots; the scanner decides which exist, and a vendor whose home is absent contributes
// nothing rather than erroring (unlike CLAUDE_CONFIG_DIR, which is an explicit claim that a dir exists).

// The env override is comma-split like CLAUDE_CONFIG_DIR, so several homes can be scanned.
function vendorHomes(
  env: NodeJS.ProcessEnv,
  varName: string,
  defaultDirName: string,
  homeDir: string | null,
): string[] {
  const rawOverride = env?.[varName];
  const override = typeof rawOverride === 'string' ? rawOverride.trim() : '';
  if (override) return normalizeHomeCandidates(override.split(','), env, homeDir);
  const home = resolveHomeDir(env, homeDir);
  if (!home) return [];
  return [path.join(home, defaultDirName)];
}

function codexHomes(env: NodeJS.ProcessEnv = process.env, homeDir: string | null = null): string[] {
  return vendorHomes(env, 'CODEX_HOME', '.codex', homeDir);
}

function grokHomes(env: NodeJS.ProcessEnv = process.env, homeDir: string | null = null): string[] {
  return vendorHomes(env, 'GROK_HOME', '.grok', homeDir);
}

// ccusage's Codex root rule: sessions/ and archived_sessions/ when present, else the home itself as
// a flat JSONL dir (a real ~/.codex also holds history.jsonl and plugin fixtures, which are not usage).
function codexRootCandidates(homes: string[]): VendorRoot[] {
  const candidates: VendorRoot[] = [];
  for (const home of homes) {
    candidates.push({ dir: path.join(home, 'sessions'), kind: 'active', home });
    candidates.push({ dir: path.join(home, 'archived_sessions'), kind: 'archived', home });
  }
  return candidates;
}

function codexFallbackRoots(homes: string[], survivingRoots: VendorRoot[]): VendorRoot[] {
  const covered = new Set(survivingRoots.map((root) => root.home));
  return homes.filter((home) => !covered.has(home)).map((home) => ({ dir: home, kind: 'flat', home }));
}

// Grok stores one updates.jsonl per session under sessions/<encoded-cwd>/<session-id>/.
function grokRootCandidates(homes: string[]): VendorRoot[] {
  return homes.map((home) => ({ dir: path.join(home, 'sessions'), kind: 'active', home }));
}

const GROK_USAGE_FILENAME = 'updates.jsonl';

// Which files in a vendor's tree are usage at all. Grok is the narrow one: everything else in its
// session dir is transcript detail we never read.
function isUsageFile(vendor: string, fileName: unknown): boolean {
  if (typeof fileName !== 'string') return false;
  if (vendor === 'grok') return fileName === GROK_USAGE_FILENAME;
  return fileName.endsWith('.jsonl');
}

// ccusage's active-over-archived rule, keyed on basename: the active copy is still being appended to.
function dedupeCodexFiles<T extends { file: string; kind: string }>(files: T[]): T[] {
  const byName = new Map<string, T>();
  for (const file of files) {
    const name = path.basename(file.file);
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, file);
      continue;
    }
    if (existing.kind === 'archived' && file.kind !== 'archived') byName.set(name, file);
  }
  return Array.from(byName.values());
}

// The Codex session id is the trailing uuid of a rollout file name; the basename is the fallback for
// any other layout. Codex token_count lines carry no session id of their own.
function codexSessionIdFromPath(filePath: unknown): string | null {
  const base = path.basename(String(filePath || ''), '.jsonl');
  const match = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(base);
  if (match) return match[1];
  return base || null;
}

export { decideFileRead, projectDirCandidates, resolveProjectsDirs, splitLines, codexHomes, grokHomes, codexRootCandidates, codexFallbackRoots, grokRootCandidates, codexSessionIdFromPath, dedupeCodexFiles, isUsageFile };
