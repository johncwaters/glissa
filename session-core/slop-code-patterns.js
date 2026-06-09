'use strict';

// Pure, deterministic code-slop pattern matching (in-house, no LLM, no deps).
// detectCodeSlop(content, relPath) -> [{ subrule, axis, index }], where `index`
// is a 0-based offset into `content`. The caller (session-core/post-turn-rules.js
// detectSlop) maps offsets to line/col and the post-turn finding shape. This module
// only matches; it never mutates and never touches fs/git.
//
// Scope: high-signal, low-false-positive tells the way AI coding agents leave them.
// We deliberately do NOT flag bare TODO/FIXME (legitimate in normal dev work) or try
// to detect "a comment that restates the code" (that needs an AST; a regex cannot do
// it without heavy false positives). Axes follow the Noise / Lies / Soul taxonomy.
//
// Repo convention (MEMORY dash-literals-roundtrip): NO literal em/en dash or ellipsis
// in this file. Every pattern below is ASCII only.

// Extensions the TypeScript-only subrules apply to.
const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
// Python file extension (for the `print(` debug subrule).
const PY_EXTS = new Set(['.py']);

// Lowercased extension (including the dot) of a repo-relative path, or '' if none.
function extOf(relPath) {
  if (!relPath) return '';
  const s = String(relPath).replace(/\\/g, '/');
  const base = s.slice(s.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

// Each subrule: { id, axis, re (global regex), langs?: Set<ext> }. When `langs` is
// present the subrule only runs for files whose extension is in that set. A missing
// `langs` means "any text file".
const SUBRULES = [
  // Lies: a catch block that swallows the error (empty, or comment-only body).
  {
    id: 'swallowed-exception',
    axis: 'lies',
    re: /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)?\}/g,
  },
  // Noise: AI narration openers on a comment line.
  {
    id: 'opener-comment',
    axis: 'noise',
    re: /^[ \t]*(?:\/\/+|#|\*)[ \t]*(?:(?:now|first|next|then|here)[, ]+(?:we|let)\b|let'?s\b|we\s+(?:now|then|will|can|need|first)\b|this\s+(?:function|method|class|code|section|block|module|file)\b|step\s+\d+\s*:)/gim,
  },
  // Lies: placeholder / "not really implemented" hand-waving.
  {
    id: 'placeholder',
    axis: 'lies',
    re: /(?:in\s+a\s+real\s+(?:implementation|app|application|world|system|scenario|project)|in\s+production(?:[,\s]|\b)|for\s+now[, ]+(?:we|just|this|i'?ll|return|use)|this\s+is\s+(?:a\s+)?simplified|simplified\s+(?:version|example|implementation)|for\s+(?:demonstration|illustration|example)\s+purposes|placeholder\s+(?:for|implementation|value)|you\s+(?:would|could|might|may)\s+(?:want\s+to\s+)?(?:add|implement|replace|put))/gi,
  },
  // Noise: debug statements left in (JS/TS family and anything with console).
  {
    id: 'debug-leftover',
    axis: 'noise',
    re: /\bconsole\.(?:log|debug|info|trace)\s*\(|\bdebugger\b/g,
  },
  // Noise: stray print( in Python.
  {
    id: 'debug-print-py',
    axis: 'noise',
    langs: PY_EXTS,
    re: /^[ \t]*print\s*\(/gim,
  },
  // Soul: hedging comments that signal the author was not sure.
  {
    id: 'hedge-comment',
    axis: 'soul',
    re: /(?:\/\/+|#)[^\n]*\b(?:should\s+(?:work|be\s+fine|do\s+it|handle)|not\s+(?:entirely\s+)?sure|probably\s+(?:works?|fine|ok|okay)|hopefully|i\s+think\s+this|might\s+(?:work|break|fail)|not\s+sure\s+(?:why|if|how))\b/gi,
  },
  // Soul: type/lint escape hatches (TypeScript files only, to avoid JS false positives).
  {
    id: 'type-escape',
    axis: 'soul',
    langs: TS_EXTS,
    re: /\bas\s+any\b|:\s*any(?:\b|\[)|@ts-(?:ignore|nocheck|expect-error)\b|eslint-disable(?:-next-line|-line)?\b/g,
  },
];

// Max matches mapped per file. A file at the cap is already very sloppy; the exact count
// past it is not actionable, and the cap bounds worst-case time and allocation on a
// pathological (e.g. minified) changed file. The caller surfaces only a count.
const DEFAULT_FINDINGS_CAP = 200;

// Run all in-scope subrules over `content`. Returns matches in ascending offset order,
// at most `cap` of them. Uses a manual exec loop (not matchAll) so it can stop early at
// the cap; all SUBRULE patterns are non-zero-width, so exec always advances lastIndex.
function detectCodeSlop(content, relPath, cap = DEFAULT_FINDINGS_CAP) {
  if (typeof content !== 'string' || content.length === 0) return [];
  const ext = extOf(relPath);
  const findings = [];
  for (const sub of SUBRULES) {
    if (sub.langs && !sub.langs.has(ext)) continue;
    // Fresh lastIndex per file: the regex literals are module-global (stateful).
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

module.exports = { detectCodeSlop, extOf, DEFAULT_FINDINGS_CAP };
