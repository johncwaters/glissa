'use strict';

// Unit tests for the pure post-turn hygiene rules (session/core/post-turn-rules.js).
// Repo convention (MEMORY dash-literals-roundtrip): NO literal em/en dash or
// ellipsis in this file; build them via String.fromCharCode.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fixTrailingWhitespace,
  fixFinalNewline,
  stripBom,
  detectSlop,
  applyRules,
  exemptions,
  shouldCheckPath,
  looksBinary,
} = require('../session/core/post-turn-rules');
const { detectCodeSlop } = require('../session/core/slop-code-patterns');

const BOM = String.fromCharCode(0xfeff);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

const allRules = {
  bom: { enabled: true, mode: 'fix' },
  trailingWs: { enabled: true, mode: 'fix' },
  finalNewline: { enabled: true, mode: 'fix' },
};

// --- fixTrailingWhitespace ------------------------------------------------

test('fixTrailingWhitespace strips spaces/tabs before newline and at EOF', () => {
  const input = `a  ${NL}b\t${NL}c   `;
  const { content, findings } = fixTrailingWhitespace(input);
  assert.equal(content, `a${NL}b${NL}c`);
  assert.equal(findings.length, 3);
});

test('fixTrailingWhitespace is CRLF-safe (keeps CR+LF, drops the space)', () => {
  const input = `x ${CR}${NL}`;
  const { content } = fixTrailingWhitespace(input);
  assert.equal(content, `x${CR}${NL}`);
});

test('fixTrailingWhitespace is a no-op on clean content', () => {
  const input = `a${NL}b${NL}`;
  assert.deepEqual(fixTrailingWhitespace(input), { content: input, findings: [] });
});

// --- fixFinalNewline ------------------------------------------------------

test('fixFinalNewline appends exactly one newline when missing', () => {
  const { content, findings } = fixFinalNewline('abc');
  assert.equal(content, `abc${NL}`);
  assert.equal(findings.length, 1);
});

test('fixFinalNewline is a no-op when a final newline is present', () => {
  assert.deepEqual(fixFinalNewline(`abc${NL}`), { content: `abc${NL}`, findings: [] });
});

test('fixFinalNewline leaves an empty file untouched', () => {
  assert.deepEqual(fixFinalNewline(''), { content: '', findings: [] });
});

test('fixFinalNewline appends CRLF when the file uses CRLF', () => {
  const input = `a${CR}${NL}b`;
  const { content } = fixFinalNewline(input);
  assert.equal(content, `a${CR}${NL}b${CR}${NL}`);
});

// --- stripBom -------------------------------------------------------------

test('stripBom removes only a single leading BOM', () => {
  const { content, findings } = stripBom(`${BOM}hello`);
  assert.equal(content, 'hello');
  assert.equal(findings.length, 1);
  assert.deepEqual(stripBom('hello'), { content: 'hello', findings: [] });
});

// --- detectSlop (report-only) ---------------------------------------------

test('detectSlop returns content unchanged and maps findings to line/col', () => {
  const input = `x()${NL}catch (e) {}`;
  const { content, findings } = detectSlop(input, { relPath: 'a.js' });
  assert.equal(content, input); // never mutates
  assert.ok(findings.length >= 1);
  assert.equal(findings[0].rule, 'slop');
  assert.equal(typeof findings[0].subrule, 'string');
  assert.equal(findings[0].line, 2); // catch is on line 2
});

test('detectSlop honors ctx.relPath language gating', () => {
  const input = 'const x = y as any;';
  assert.ok(detectSlop(input, { relPath: 'a.ts' }).findings.some((f) => f.subrule === 'type-escape'));
  assert.equal(detectSlop(input, { relPath: 'a.js' }).findings.length, 0);
});

test('detectSlop tolerates a missing ctx', () => {
  const { content, findings } = detectSlop('console.log(1)');
  assert.equal(content, 'console.log(1)');
  assert.ok(findings.some((f) => f.subrule === 'debug-leftover'));
});

// Naive O(line) reference: counts NL (char 10) up to a 0-based offset, mirroring posAt.
function refLineCol(content, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < Math.min(offset, content.length); i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      col = 1;
      continue;
    }
    col++;
  }
  return { line, col };
}

test('detectSlop single-pass line/col matches a naive per-finding reference (LF and CRLF)', () => {
  const unit = 'console.log(1)|// Now we init|try{f()}catch(e){}|const y = 2 // probably fine|';
  for (const sep of [NL, CR + NL]) {
    const content = unit.split('|').join(sep).repeat(8);
    // detectCodeSlop gives offsets; detectSlop maps them in the same order.
    const matches = detectCodeSlop(content, 'a.js');
    const { findings } = detectSlop(content, { relPath: 'a.js' });
    assert.ok(matches.length > 0);
    assert.equal(findings.length, matches.length);
    for (let i = 0; i < matches.length; i++) {
      const ref = refLineCol(content, matches[i].index);
      assert.equal(findings[i].subrule, matches[i].subrule);
      assert.equal(findings[i].line, ref.line, `line mismatch at finding ${i}`);
      assert.equal(findings[i].col, ref.col, `col mismatch at finding ${i}`);
    }
  }
});

// --- applyRules -----------------------------------------------------------

test('applyRules applies all enabled fix rules and reports changed', () => {
  const input = `${BOM}a   ${NL}no-newline-here`;
  const { content, findings, changed } = applyRules(input, allRules);
  assert.equal(changed, true);
  assert.equal(content.charCodeAt(0) === 0xfeff, false); // BOM gone
  assert.equal(/[ \t]+\n/.test(content), false); // trailing whitespace gone
  assert.equal(content.endsWith(NL), true); // final newline added
  assert.ok(findings.length >= 2);
});

test('applyRules respects a disabled rule', () => {
  const input = `${BOM}a   `;
  const rules = { bom: { enabled: true, mode: 'fix' }, trailingWs: { enabled: false, mode: 'fix' } };
  const { content } = applyRules(input, rules);
  assert.equal(content, 'a   '); // trailing whitespace preserved; BOM still stripped
});

test('applyRules report mode records findings without mutating', () => {
  const input = 'a   ';
  const rules = { trailingWs: { enabled: true, mode: 'report' } };
  const { content, findings, changed } = applyRules(input, rules);
  assert.equal(content, input);
  assert.equal(changed, false);
  assert.equal(findings.length, 1);
});

test('applyRules honors the bare glissa-no-fix marker (skips everything)', () => {
  const input = `glissa-no-fix${NL}a   `;
  const { content, changed } = applyRules(input, allRules);
  assert.equal(content, input);
  assert.equal(changed, false);
});

test('applyRules honors a per-rule glissa-no-fix:trailingWs marker', () => {
  const input = `${BOM}glissa-no-fix:trailingWs${NL}a   `;
  const rules = { bom: { enabled: true, mode: 'fix' }, trailingWs: { enabled: true, mode: 'fix' } };
  const { content } = applyRules(input, rules);
  // trailing whitespace preserved, but BOM still stripped
  assert.equal(/[ \t]+$/.test(content), true);
  assert.equal(content.charCodeAt(0) === 0xfeff, false);
});

test('exemptions distinguishes bare marker from per-rule marker', () => {
  assert.deepEqual(exemptions('nothing here'), { all: false, rules: new Set() });
  assert.equal(exemptions('glissa-no-fix').all, true);
  const perRule = exemptions('glissa-no-fix:slop');
  assert.equal(perRule.all, false);
  assert.equal(perRule.rules.has('slop'), true);
});

test('applyRules threads ctx to the slop rule and never mutates for it (even in fix mode)', () => {
  const input = `console.log(1)${NL}`;
  const rules = { slop: { enabled: true, mode: 'fix' } };
  const { content, findings, changed } = applyRules(input, rules, { relPath: 'a.js' });
  assert.equal(content, input); // slop is report-only: no rewrite under fix mode
  assert.equal(changed, false);
  assert.ok(findings.some((f) => f.rule === 'slop' && f.subrule === 'debug-leftover'));
});

test('applyRules honors a per-rule glissa-no-fix:slop marker', () => {
  const input = `glissa-no-fix:slop${NL}console.log(1)`;
  const rules = { slop: { enabled: true, mode: 'report' } };
  const { findings } = applyRules(input, rules, { relPath: 'a.js' });
  assert.equal(findings.some((f) => f.rule === 'slop'), false);
});

// --- shouldCheckPath ------------------------------------------------------

test('shouldCheckPath honors include and exclude globs', () => {
  const cfg = { include: ['**/*'], exclude: ['**/node_modules/**', '**/*.lock'] };
  assert.equal(shouldCheckPath('src/a.js', cfg), true);
  assert.equal(shouldCheckPath('node_modules/x/y.js', cfg), false);
  assert.equal(shouldCheckPath('pnpm-lock.lock', cfg), false);
});

test('shouldCheckPath normalizes backslashes and matches nested dirs', () => {
  const cfg = { include: ['src/**/*.js'], exclude: [] };
  assert.equal(shouldCheckPath('src\\deep\\a.js', cfg), true);
  assert.equal(shouldCheckPath('other/a.js', cfg), false);
});

// --- looksBinary ----------------------------------------------------------

test('looksBinary detects a NUL byte (Buffer and string)', () => {
  assert.equal(looksBinary(Buffer.from([0x61, 0x00, 0x62])), true);
  assert.equal(looksBinary(Buffer.from('plain text')), false);
  assert.equal(looksBinary(`a${String.fromCharCode(0)}b`), true);
});
