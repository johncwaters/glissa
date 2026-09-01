import { detectCodeSlop } from './slop-code-patterns.ts';

const BOM = String.fromCharCode(0xfeff);
const NL = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

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

function detectSlop(content: string, ctx?: RuleContext): RuleResult {
  const relPath = ctx?.relPath;
  const matches = detectCodeSlop(content, relPath);

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

function fixTrailingWhitespace(content: string): RuleResult {
  const findings: RuleFinding[] = [];
  const out = content.replace(/[ \t]+(\r?\n|$)/g, (m: string, tail: string, offset: number) => {
    const { line, col } = posAt(content, offset);
    findings.push({ rule: 'trailingWs', line, col, before: m, after: tail });
    return tail;
  });
  return { content: out, findings };
}

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

function stripBom(content: string): RuleResult {
  if (content.charCodeAt(0) !== 0xfeff) return { content, findings: [] };
  return {
    content: content.slice(1),
    findings: [{ rule: 'bom', line: 1, col: 1, before: BOM, after: '' }],
  };
}

const RULES: Readonly<Record<string, { fix: (content: string, ctx?: RuleContext) => RuleResult }>> =
  Object.freeze({
    bom: { fix: stripBom },
    trailingWs: { fix: fixTrailingWhitespace },
    finalNewline: { fix: fixFinalNewline },
    slop: { fix: detectSlop },
  });

const RULE_ORDER = ['bom', 'trailingWs', 'finalNewline', 'slop'];

const EXEMPT_MARKER = 'glissa-no-fix';

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

const REGEX_METACHARACTERS = ['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'].join('');

function starSegment(glob: string, index: number): { pattern: string; consumed: number } {
  if (glob[index + 1] !== '*') return { pattern: '[^/]*', consumed: 0 };
  if (glob[index + 2] === '/') return { pattern: '(?:.*/)?', consumed: 2 };
  return { pattern: '.*', consumed: 1 };
}

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

function shouldCheckPath(relPath: string, { include, exclude }: PathScope = {}): boolean {
  const p = String(relPath).replace(/\\/g, '/');
  const inc = include?.length ? include : ['**/*'];
  const matchAny = (globs: string[]) => globs.some((g) => globToRegExp(g).test(p));
  if (!matchAny(inc)) return false;
  if (exclude?.length && matchAny(exclude)) return false;
  return true;
}

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
