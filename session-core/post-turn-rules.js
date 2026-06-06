'use strict';

// Pure post-turn hygiene rules. No fs, no git, no async. Each rule is
// (content) -> { content, findings } and is idempotent. The thin IO runner
// (../post-turn-checker.js) lists a session's git-changed files and applies these.
//
// Repo convention (MEMORY dash-literals-roundtrip): this file must contain NO
// literal em dash / en dash / ellipsis character. The characters this module
// rewrites are referenced ONLY via String.fromCharCode so the no-dash policy
// round-trips through source and tests.

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);
const BOM = String.fromCharCode(0xfeff);
const NL = String.fromCharCode(10); // '\n'
const CRLF = String.fromCharCode(13, 10); // '\r\n'

// Map a 0-based string offset to 1-based { line, col } (for finding tooltips).
function posAt(content, offset) {
  let line = 1;
  let col = 1;
  const end = Math.min(offset, content.length);
  for (let i = 0; i < end; i++) {
    if (content[i] === NL) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

// em/en dash -> ASCII hyphen; ellipsis char -> three ASCII dots.
function fixDashes(content) {
  const findings = [];
  let out = '';
  let line = 1;
  let col = 1;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === EM_DASH || ch === EN_DASH) {
      findings.push({ rule: 'dashes', line, col, before: ch, after: '-' });
      out += '-';
    } else if (ch === ELLIPSIS) {
      findings.push({ rule: 'dashes', line, col, before: ch, after: '...' });
      out += '...';
    } else {
      out += ch;
    }
    if (ch === NL) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { content: out, findings };
}

// Strip [ \t]+ before a newline and at end-of-file. CRLF-safe (keeps the CR+LF).
function fixTrailingWhitespace(content) {
  const findings = [];
  const out = content.replace(/[ \t]+(\r?\n|$)/g, (m, tail, offset) => {
    const { line, col } = posAt(content, offset);
    findings.push({ rule: 'trailingWs', line, col, before: m, after: tail });
    return tail;
  });
  return { content: out, findings };
}

// Ensure exactly one trailing newline. No-op when already present; never collapses
// existing blank lines; appends in the file's own ending style. Empty file untouched.
function fixFinalNewline(content) {
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
function stripBom(content) {
  if (content.charCodeAt(0) !== 0xfeff) return { content, findings: [] };
  return {
    content: content.slice(1),
    findings: [{ rule: 'bom', line: 1, col: 1, before: BOM, after: '' }],
  };
}

// Rule registry (name -> transform). Config-facing enable defaults live in the
// runner's DEFAULTS.rules, not here, so this is purely the transform lookup.
const RULES = Object.freeze({
  bom: { fix: stripBom },
  dashes: { fix: fixDashes },
  trailingWs: { fix: fixTrailingWhitespace },
  finalNewline: { fix: fixFinalNewline },
});

// Fixed apply order: BOM first, newline last (so it sees post-trim content).
const RULE_ORDER = ['bom', 'dashes', 'trailingWs', 'finalNewline'];

const EXEMPT_MARKER = 'glissa-no-fix';

// Scan the first 4KB for opt-out markers. A bare `glissa-no-fix` disables all
// rules for the file; `glissa-no-fix:<rule>` disables just that rule.
function exemptions(content) {
  const head = content.slice(0, 4096);
  if (head.indexOf(EXEMPT_MARKER) === -1) return { all: false, rules: new Set() };
  const rules = new Set();
  const re = new RegExp(EXEMPT_MARKER + ':([a-zA-Z]+)', 'g');
  let m;
  while ((m = re.exec(head)) !== null) rules.add(m[1]);
  const all = new RegExp(EXEMPT_MARKER + '(?!:)').test(head);
  return { all, rules };
}

// Apply enabled rules in RULE_ORDER. `rules` is a normalized map
// { <name>: { enabled, mode } }; mode 'fix' applies the transform, 'report' only
// records findings. Returns { content, findings, changed }.
function applyRules(content, rules) {
  const ex = exemptions(content);
  const findings = [];
  let current = content;
  for (const name of RULE_ORDER) {
    const cfg = rules && rules[name];
    if (!cfg || !cfg.enabled) continue;
    if (ex.all || ex.rules.has(name)) continue;
    const res = RULES[name].fix(current);
    if (res.findings.length === 0) continue;
    for (const f of res.findings) findings.push(f);
    if (cfg.mode !== 'report') current = res.content;
  }
  return { content: current, findings, changed: current !== content };
}

// Tiny glob -> RegExp (supports **, *, ?). No new dependency.
function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.indexOf(c) !== -1) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

// A path is in scope if it matches >=1 include glob and 0 exclude globs.
function shouldCheckPath(relPath, { include, exclude } = {}) {
  const p = String(relPath).replace(/\\/g, '/');
  const inc = include && include.length ? include : ['**/*'];
  const matchAny = (globs) => globs.some((g) => globToRegExp(g).test(p));
  if (!matchAny(inc)) return false;
  if (exclude && exclude.length && matchAny(exclude)) return false;
  return true;
}

// NUL byte in the first 8KB => treat as binary, skip. Accepts Buffer or string.
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  const at = typeof buf === 'string' ? (i) => buf.charCodeAt(i) : (i) => buf[i];
  for (let i = 0; i < n; i++) if (at(i) === 0) return true;
  return false;
}

module.exports = {
  RULES,
  RULE_ORDER,
  applyRules,
  exemptions,
  shouldCheckPath,
  globToRegExp,
  looksBinary,
  fixDashes,
  fixTrailingWhitespace,
  fixFinalNewline,
  stripBom,
};
