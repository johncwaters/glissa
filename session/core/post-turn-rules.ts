// Pure post-turn hygiene rules. No fs, no git, no async. Each rule is
// (content) -> { content, findings } and is idempotent. The thin IO runner
// (../post-turn-checker.js) lists a session's git-changed files and applies these.
//
// Repo convention: this file must contain NO literal em dash / en dash /
// ellipsis character (build any needed via String.fromCharCode).

import { detectCodeSlop } from './slop-code-patterns.ts';

const BOM = String.fromCharCode(0xfeff);
const NL = String.fromCharCode(10); // '\n'
const CRLF = String.fromCharCode(13, 10); // '\r\n'

interface RuleFinding {
  rule: string;
  line: number;
  col: number;
  subrule?: string;
  axis?: string;
  before?: string;
  after?: string;
}

interface RuleResult {
  content: string;
  findings: RuleFinding[];
}

interface RuleContext {
  relPath?: string;
}

interface RuleConfig {
  enabled?: boolean;
  mode?: string;
}

interface PathScope {
  include?: string[];
  exclude?: string[];
}

// Map a 0-based string offset to 1-based { line, col } (for finding tooltips).
function posAt(content: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  const end = Math.min(offset, content.length);
  for (let i = 0; i < end; i++) {
    if (content[i] !== NL) {
      col++;
      continue;
    }
    line++;
    col = 1;
  }
  return { line, col };
}

// Report-only code-slop detector. Unlike the other rules it NEVER mutates: it returns
// `content` unchanged and a finding per match, so even under mode 'fix' it can only flag,
// never rewrite (slop is a judgement call, and these run on code files too). `ctx.relPath`
// drives language gating in detectCodeSlop (TS-only / py-only subrules). Pure delegation:
// the pattern matching lives in ./slop-code-patterns; here we only map offsets to line/col.
function detectSlop(content: string, ctx?: RuleContext): RuleResult {
  const relPath = ctx?.relPath;
  const matches = detectCodeSlop(content, relPath);
  // Single linear sweep instead of per-finding posAt. detectCodeSlop returns matches in
  // ascending offset order, so one monotonic cursor maps every offset to line/col in
  // O(N + F). The old posAt-per-finding cost O(F * N) and froze the shared event loop on a
  // match-heavy file (measured 421ms -> 0.5ms). Mirrors posAt: only NL (char 10) ends a line.
  const findings: RuleFinding[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;
  for (const m of matches) {
    const target = m.index < content.length ? m.index : content.length;
    while (pos < target) {
      if (content.charCodeAt(pos) === 10) {
        line++;
        col = 1;
        pos++;
        continue;
      }
      col++;
      pos++;
    }
    findings.push({ rule: 'slop', subrule: m.subrule, axis: m.axis, line, col });
  }
  return { content, findings };
}

// Strip [ \t]+ before a newline and at end-of-file. CRLF-safe (keeps the CR+LF).
function fixTrailingWhitespace(content: string): RuleResult {
  const findings: RuleFinding[] = [];
  const out = content.replace(/[ \t]+(\r?\n|$)/g, (m: string, tail: string, offset: number) => {
    const { line, col } = posAt(content, offset);
    findings.push({ rule: 'trailingWs', line, col, before: m, after: tail });
    return tail;
  });
  return { content: out, findings };
}

// Ensure exactly one trailing newline. No-op when already present; never collapses
// existing blank lines; appends in the file's own ending style. Empty file untouched.
function fixFinalNewline(content: string): RuleResult {
  if (content === '' || content.charCodeAt(content.length - 1) === 10) {
    return { content, findings: [] };
  }
  const nl = content.indexOf(CRLF) !== -1 ? CRLF : NL;
  const { line, col } = posAt(content, content.length);
  return {
    content: content + nl,
    findings: [{ rule: 'finalNewline', line, col, before: '', after: nl }],
  };
}

// Remove a single leading UTF-8 BOM.
function stripBom(content: string): RuleResult {
  if (content.charCodeAt(0) !== 0xfeff) return { content, findings: [] };
  return {
    content: content.slice(1),
    findings: [{ rule: 'bom', line: 1, col: 1, before: BOM, after: '' }],
  };
}

// Rule registry (name -> transform). Config-facing enable defaults live in the
// runner's DEFAULTS.rules, not here, so this is purely the transform lookup.
const RULES: Readonly<Record<string, { fix: (content: string, ctx?: RuleContext) => RuleResult }>> =
  Object.freeze({
    bom: { fix: stripBom },
    trailingWs: { fix: fixTrailingWhitespace },
    finalNewline: { fix: fixFinalNewline },
    slop: { fix: detectSlop },
  });

// Fixed apply order: BOM first, newline last (so it sees post-trim content). `slop` is
// report-only and order-independent; it runs last.
const RULE_ORDER = ['bom', 'trailingWs', 'finalNewline', 'slop'];

const EXEMPT_MARKER = 'glissa-no-fix';

// Scan the first 4KB for opt-out markers. A bare `glissa-no-fix` disables all
// rules for the file; `glissa-no-fix:<rule>` disables just that rule.
function exemptions(content: string): { all: boolean; rules: Set<string> } {
  const head = content.slice(0, 4096);
  if (head.indexOf(EXEMPT_MARKER) === -1) return { all: false, rules: new Set<string>() };
  const rules = new Set<string>();
  const re = new RegExp(`${EXEMPT_MARKER}:([a-zA-Z]+)`, 'g');
  let m = re.exec(head);
  while (m !== null) {
    rules.add(m[1]);
    m = re.exec(head);
  }
  const all = new RegExp(`${EXEMPT_MARKER}(?!:)`).test(head);
  return { all, rules };
}

// Apply enabled rules in RULE_ORDER. `rules` is a normalized map
// { <name>: { enabled, mode } }; mode 'fix' applies the transform, 'report' only
// records findings. Returns { content, findings, changed }.
function applyRules(
  content: string,
  rules: Record<string, RuleConfig | undefined> | null | undefined,
  ctx?: RuleContext,
): { content: string; findings: RuleFinding[]; changed: boolean } {
  const ex = exemptions(content);
  const findings: RuleFinding[] = [];
  let current = content;
  for (const name of RULE_ORDER) {
    const cfg = rules?.[name];
    if (!cfg || !cfg.enabled) continue;
    if (ex.all || ex.rules.has(name)) continue;
    const res = RULES[name].fix(current, ctx);
    if (res.findings.length === 0) continue;
    for (const f of res.findings) findings.push(f);
    if (cfg.mode !== 'report') current = res.content;
  }
  return { content: current, findings, changed: current !== content };
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: this is a literal regex metacharacter class, not a template
const REGEX_METACHARACTERS = '.+^${}()|[]\\';

// What a `*` at `index` contributes, plus how many extra chars of the glob it consumed.
function starSegment(glob: string, index: number): { pattern: string; consumed: number } {
  if (glob[index + 1] !== '*') return { pattern: '[^/]*', consumed: 0 };
  if (glob[index + 2] === '/') return { pattern: '(?:.*/)?', consumed: 2 };
  return { pattern: '.*', consumed: 1 };
}

// Tiny glob -> RegExp (supports **, *, ?). No new dependency.
function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      const segment = starSegment(glob, i);
      re += segment.pattern;
      i += segment.consumed;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      continue;
    }
    if (REGEX_METACHARACTERS.indexOf(c) !== -1) {
      re += `\\${c}`;
      continue;
    }
    re += c;
  }
  re += '$';
  return new RegExp(re);
}

// A path is in scope if it matches >=1 include glob and 0 exclude globs.
function shouldCheckPath(relPath: string, { include, exclude }: PathScope = {}): boolean {
  const p = String(relPath).replace(/\\/g, '/');
  const inc = include?.length ? include : ['**/*'];
  const matchAny = (globs: string[]) => globs.some((g) => globToRegExp(g).test(p));
  if (!matchAny(inc)) return false;
  if (exclude?.length && matchAny(exclude)) return false;
  return true;
}

// NUL byte in the first 8KB => treat as binary, skip. Accepts Buffer or string.
function looksBinary(buf: string | Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  const at = typeof buf === 'string'
    ? (i: number) => buf.charCodeAt(i)
    : (i: number) => buf[i];
  for (let i = 0; i < n; i++) if (at(i) === 0) return true;
  return false;
}

export {
  applyRules,
  exemptions,
  shouldCheckPath,
  globToRegExp,
  looksBinary,
  fixTrailingWhitespace,
  fixFinalNewline,
  stripBom,
  detectSlop,
};
export type { PathScope, RuleConfig, RuleContext, RuleFinding, RuleResult };
