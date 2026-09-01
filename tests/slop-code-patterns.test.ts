import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { detectCodeSlop, extOf, DEFAULT_FINDINGS_CAP } from '../session/core/slop-code-patterns.ts';

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);

function subrules(content: string, relPath?: string) {
  return detectCodeSlop(content, relPath).map((f) => f.subrule);
}

test('extOf lowercases the extension and ignores dotfiles/no-ext', () => {
  assert.equal(extOf('a/b/c.TS'), '.ts');
  assert.equal(extOf('x\\y\\z.py'), '.py');
  assert.equal(extOf('Makefile'), '');
  assert.equal(extOf('.gitignore'), '');
  assert.equal(extOf(undefined), '');
});

test('flags empty and comment-only catch blocks, not handled ones', () => {
  assert.ok(subrules('try { f() } catch (e) {}', 'a.js').includes('swallowed-exception'));
  assert.ok(subrules('try { f() } catch { /* ignore */ }', 'a.js').includes('swallowed-exception'));
  assert.equal(
    subrules('try { f() } catch (e) { log(e); throw e; }', 'a.js').includes('swallowed-exception'),
    false,
  );
});

test('flags AI narration openers, not ordinary comments', () => {
  assert.ok(subrules('// Now we initialize the cache', 'a.js').includes('opener-comment'));
  assert.ok(subrules('// This function returns the total', 'a.js').includes('opener-comment'));
  assert.ok(subrules('# Step 1: parse the input', 'a.py').includes('opener-comment'));
  assert.equal(subrules('// returns the total', 'a.js').includes('opener-comment'), false);
  assert.equal(subrules('// TODO: clean this up', 'a.js').includes('opener-comment'), false);
});

test('flags placeholder hand-waving but not normal prose', () => {
  assert.ok(subrules('// in a real implementation this calls the API', 'a.js').includes('placeholder'));
  assert.ok(subrules('return 0; // for now, just return a stub', 'a.js').includes('placeholder'));
  assert.equal(subrules('const realValue = compute();', 'a.js').includes('placeholder'), false);
});

test('bare TODO/FIXME is not flagged', () => {
  const found = subrules('// TODO: handle the edge case\n// FIXME later', 'a.js');
  assert.equal(found.includes('placeholder'), false);
});

test('flags console.* and debugger, not lookalikes', () => {
  assert.ok(subrules('console.log("x")', 'a.js').includes('debug-leftover'));
  assert.ok(subrules('  debugger;', 'a.ts').includes('debug-leftover'));
  assert.equal(subrules('logger.info("x")', 'a.js').includes('debug-leftover'), false);
});

test('python print is flagged only on .py', () => {
  assert.ok(subrules('print("x")', 'a.py').includes('debug-print-py'));
  assert.equal(subrules('print("x")', 'a.js').includes('debug-print-py'), false);
});

test('flags hedging comments, not confident ones', () => {
  assert.ok(subrules('// this should work for most cases', 'a.js').includes('hedge-comment'));
  assert.ok(subrules('# probably fine', 'a.py').includes('hedge-comment'));
  assert.equal(subrules('// validated against the schema', 'a.js').includes('hedge-comment'), false);
});

test('type-escape fires on TS files only', () => {
  assert.ok(subrules('const x = y as any;', 'a.ts').includes('type-escape'));
  assert.ok(subrules('// @ts-ignore\nfoo();', 'a.tsx').includes('type-escape'));
  assert.equal(subrules('const x = y as any;', 'a.js').includes('type-escape'), false);
});

test('findings carry subrule, axis, and ascending index', () => {
  const content = 'console.log(1)\n// in a real implementation we skip this';
  const found = detectCodeSlop(content, 'a.js');
  assert.ok(found.length >= 2);
  for (const f of found) {
    assert.equal(typeof f.subrule, 'string');
    assert.ok(['noise', 'lies', 'soul'].includes(f.axis));
    assert.equal(typeof f.index, 'number');
  }
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i].index >= found[i - 1].index);
  }
});

test('empty or non-string content yields no findings', () => {
  assert.deepEqual(detectCodeSlop('', 'a.js'), []);
  assert.deepEqual(detectCodeSlop(null, 'a.js'), []);
});

test('detectCodeSlop caps total findings (default and explicit)', () => {
  const content = 'console.log(1)\n'.repeat(500);
  assert.equal(detectCodeSlop(content, 'a.js').length, DEFAULT_FINDINGS_CAP);
  assert.equal(detectCodeSlop(content, 'a.js', 50).length, 50);
  assert.equal(detectCodeSlop(content, 'a.js', 10000).length, 500);
});

test('detectCodeSlop is idempotent (no shared-regex lastIndex leak)', () => {
  const content = 'console.log(1)\n// Now we go\ntry{f()}catch(e){}\n';
  const first = detectCodeSlop(content, 'a.js');
  const second = detectCodeSlop(content, 'a.js');
  assert.deepEqual(first, second);

  detectCodeSlop('const x = y as any;', 'a.ts');
  assert.deepEqual(detectCodeSlop(content, 'a.js'), first);
});

test('new slop source files contain no literal em/en dash or ellipsis', () => {
  const files = ['session/core/slop-code-patterns.ts', 'session/core/anti-slop-prompt.ts'];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');
    assert.equal(src.includes(EM_DASH), false, `${rel} has an em dash`);
    assert.equal(src.includes(EN_DASH), false, `${rel} has an en dash`);
    assert.equal(src.includes(ELLIPSIS), false, `${rel} has an ellipsis`);
  }
});
