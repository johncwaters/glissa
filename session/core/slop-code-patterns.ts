
const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const PY_EXTS = new Set(['.py']);

interface SlopSubrule {
  id: string;
  axis: string;
  re: RegExp;
  langs?: Set<string>;
}

interface SlopMatch {
  subrule: string;
  axis: string;
  index: number;
}

function extOf(relPath: unknown): string {
  if (!relPath) return '';
  const s = String(relPath).replace(/\\/g, '/');
  const base = s.slice(s.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

const SUBRULES: SlopSubrule[] = [
  {
    id: 'swallowed-exception',
    axis: 'lies',
    re: /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)?\}/g,
  },
  {
    id: 'opener-comment',
    axis: 'noise',
    re: /^[ \t]*(?:\/\/+|#|\*)[ \t]*(?:(?:now|first|next|then|here)[, ]+(?:we|let)\b|let'?s\b|we\s+(?:now|then|will|can|need|first)\b|this\s+(?:function|method|class|code|section|block|module|file)\b|step\s+\d+\s*:)/gim,
  },
  {
    id: 'placeholder',
    axis: 'lies',
    re: /(?:in\s+a\s+real\s+(?:implementation|app|application|world|system|scenario|project)|in\s+production(?:[,\s]|\b)|for\s+now[, ]+(?:we|just|this|i'?ll|return|use)|this\s+is\s+(?:a\s+)?simplified|simplified\s+(?:version|example|implementation)|for\s+(?:demonstration|illustration|example)\s+purposes|placeholder\s+(?:for|implementation|value)|you\s+(?:would|could|might|may)\s+(?:want\s+to\s+)?(?:add|implement|replace|put))/gi,
  },
  {
    id: 'debug-leftover',
    axis: 'noise',
    re: /\bconsole\.(?:log|debug|info|trace)\s*\(|\bdebugger\b/g,
  },
  {
    id: 'debug-print-py',
    axis: 'noise',
    langs: PY_EXTS,
    re: /^[ \t]*print\s*\(/gim,
  },
  {
    id: 'hedge-comment',
    axis: 'soul',
    re: /(?:\/\/+|#)[^\n]*\b(?:should\s+(?:work|be\s+fine|do\s+it|handle)|not\s+(?:entirely\s+)?sure|probably\s+(?:works?|fine|ok|okay)|hopefully|i\s+think\s+this|might\s+(?:work|break|fail)|not\s+sure\s+(?:why|if|how))\b/gi,
  },
  {
    id: 'type-escape',
    axis: 'soul',
    langs: TS_EXTS,
    re: /\bas\s+any\b|:\s*any(?:\b|\[)|@ts-(?:ignore|nocheck|expect-error)\b|eslint-disable(?:-next-line|-line)?\b/g,
  },
];

const DEFAULT_FINDINGS_CAP = 200;

function detectCodeSlop(content: unknown, relPath?: unknown, cap = DEFAULT_FINDINGS_CAP): SlopMatch[] {
  if (typeof content !== 'string' || content.length === 0) return [];
  const ext = extOf(relPath);
  const findings: SlopMatch[] = [];
  for (const sub of SUBRULES) {
    if (sub.langs && !sub.langs.has(ext)) continue;
    sub.re.lastIndex = 0;
    for (;;) {
      const m = sub.re.exec(content);
      if (m === null) break;
      findings.push({ subrule: sub.id, axis: sub.axis, index: m.index });
      if (findings.length >= cap) break;
    }
    if (findings.length >= cap) break;
  }
  findings.sort((a, b) => a.index - b.index);
  return findings;
}

export { detectCodeSlop, extOf, DEFAULT_FINDINGS_CAP };
export type { SlopMatch, SlopSubrule };
