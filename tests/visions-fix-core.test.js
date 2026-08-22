'use strict';

// Tier 1 silent fixes (docs/archive/plan-navigator-2.md, M6), at the altitude where every decision lives: what a
// detector's fix edits, which of them may be applied unasked, which ones a selection is asking about, and
// what the LSP payloads carrying them look like.

const test = require('node:test');
const assert = require('node:assert/strict');

const { sweepMarkdown, sweepMarkdownWithFixes } = require('../server/core/visions-rules-core');
const {
  AUTO_SAFE_CODES,
  appendFixLog,
  autoSafeFixes,
  buildApplyEditParams,
  buildCodeActions,
  filterFixesByRange,
  fixLogEntry,
  fixPayload,
  isAutoSafeFix,
  isFixSetFresh,
  rangesOverlap,
  readSweepResult,
} = require('../server/core/visions-fix-core');

const REPEAT_TEXT = '# Title\n\nA line with with a repeat.\n';
const FENCE_TEXT = '# Title\n\n```js\nconst answer = 42;\n';

function applyEdit(text, editRange, newText) {
  const lines = text.split('\n');
  const line = lines[editRange.start.line];
  lines[editRange.start.line] = line.slice(0, editRange.start.character) + newText + line.slice(editRange.end.character);
  return lines.join('\n');
}

test('the diagnostics half of the new sweep is byte-identical to the old one', () => {
  for (const text of [REPEAT_TEXT, FENCE_TEXT, '# A\n\n### C\n', '']) {
    assert.deepEqual(sweepMarkdownWithFixes(text).diagnostics, sweepMarkdown(text));
  }
});

test('a repeated word is fixed by deleting the second word with its separator', () => {
  const { fixes } = sweepMarkdownWithFixes(REPEAT_TEXT);
  assert.equal(fixes.length, 1);
  const [fix] = fixes;
  assert.equal(fix.code, 'repeated-word');
  assert.equal(fix.message, 'Repeated word "with"');
  assert.equal(fix.newText, '');
  assert.deepEqual(fix.range, { start: { line: 2, character: 12 }, end: { line: 2, character: 16 } });
  assert.deepEqual(fix.editRange, { start: { line: 2, character: 11 }, end: { line: 2, character: 16 } });
  assert.equal(applyEdit(REPEAT_TEXT, fix.editRange, fix.newText), '# Title\n\nA line with a repeat.\n');
});

test('an unclosed fence is fixed by a closing fence at the end of the document', () => {
  const { fixes } = sweepMarkdownWithFixes(FENCE_TEXT);
  assert.equal(fixes.length, 1);
  const [fix] = fixes;
  assert.equal(fix.code, 'unclosed-fence');
  assert.deepEqual(fix.editRange.start, fix.editRange.end, 'an insertion, never a replacement');
  assert.deepEqual(fix.editRange.start, { line: 4, character: 0 }, 'the end of a document ending in a newline');
  assert.equal(fix.newText, '```\n');
});

test('a document with no trailing newline gets one ahead of the closing fence', () => {
  const { fixes } = sweepMarkdownWithFixes('```js\nconst answer = 42;');
  assert.deepEqual(fixes[0].editRange.start, { line: 1, character: 'const answer = 42;'.length });
  assert.equal(fixes[0].newText, '\n```\n');
});

test('a heading skip offers no fix at all, because there is no one right level to jump to', () => {
  const { diagnostics, fixes } = sweepMarkdownWithFixes('# A\n\n### C\n');
  assert.deepEqual(diagnostics.map((d) => d.code), ['heading-skip']);
  assert.deepEqual(fixes, []);
});

test('only the repeated word is auto-safe, because the fence fix guesses a position', () => {
  assert.deepEqual([...AUTO_SAFE_CODES], ['repeated-word']);
  assert.equal(isAutoSafeFix({ code: 'repeated-word' }), true);
  assert.equal(isAutoSafeFix({ code: 'unclosed-fence' }), false);
  assert.equal(isAutoSafeFix(null), false);

  const mixed = [...sweepMarkdownWithFixes(REPEAT_TEXT).fixes, ...sweepMarkdownWithFixes(FENCE_TEXT).fixes];
  assert.deepEqual(autoSafeFixes(mixed).map((fix) => fix.code), ['repeated-word']);
  assert.deepEqual(autoSafeFixes(null), []);
});

test('a sweep that reports diagnostics alone is read as having no fixes rather than throwing', () => {
  assert.deepEqual(readSweepResult([{ code: 'repeated-word' }]), { diagnostics: [{ code: 'repeated-word' }], fixes: [] });
  assert.deepEqual(readSweepResult(null), { diagnostics: [], fixes: [] });
  assert.deepEqual(readSweepResult({ diagnostics: 'no', fixes: 'no' }), { diagnostics: [], fixes: [] });
});

test('overlap is inclusive at both ends, so a caret touching a finding still offers its fix', () => {
  const finding = { start: { line: 2, character: 12 }, end: { line: 2, character: 16 } };
  const caretAtStart = { start: { line: 2, character: 12 }, end: { line: 2, character: 12 } };
  const caretAtEnd = { start: { line: 2, character: 16 }, end: { line: 2, character: 16 } };
  const before = { start: { line: 2, character: 0 }, end: { line: 2, character: 11 } };
  const otherLine = { start: { line: 5, character: 0 }, end: { line: 5, character: 40 } };

  assert.equal(rangesOverlap(finding, caretAtStart), true);
  assert.equal(rangesOverlap(finding, caretAtEnd), true);
  assert.equal(rangesOverlap(finding, before), false);
  assert.equal(rangesOverlap(finding, otherLine), false);
  assert.equal(rangesOverlap(finding, null), false);
});

test('a request filters the stored fixes by what it selected, and an absent range asks about all of them', () => {
  const fixes = sweepMarkdownWithFixes('a a b\n\nc c d\n').fixes;
  assert.equal(fixes.length, 2);

  const firstLine = filterFixesByRange(fixes, { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } });
  assert.deepEqual(firstLine.map((fix) => fix.range.start.line), [0]);
  assert.deepEqual(filterFixesByRange(fixes, undefined).length, 2, 'an absent range is the whole document');
  assert.deepEqual(filterFixesByRange(fixes, { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } }), []);
});

test('a code action is a quickfix carrying its diagnostic and one versioned document change', () => {
  const [fix] = sweepMarkdownWithFixes(REPEAT_TEXT).fixes;
  const [action] = buildCodeActions([fix], { uri: 'file:///note.md', version: 7 });

  assert.equal(action.title, 'Delete the repeated word');
  assert.equal(action.kind, 'quickfix');
  assert.deepEqual(action.diagnostics, [{
    range: fix.range, severity: 2, source: 'glissa-visions', code: 'repeated-word', message: 'Repeated word "with"',
  }]);
  assert.deepEqual(action.edit, {
    documentChanges: [{
      textDocument: { uri: 'file:///note.md', version: 7 },
      edits: [{ range: fix.editRange, newText: '' }],
    }],
  });
});

test('a version that is not a number becomes null rather than an unchecked edit', () => {
  const [fix] = sweepMarkdownWithFixes(REPEAT_TEXT).fixes;
  const [action] = buildCodeActions([fix], { uri: 'file:///note.md', version: undefined });
  assert.equal(action.edit.documentChanges[0].textDocument.version, null);
});

test('an applyEdit batches one sweep into a single versioned change, labelled by its size', () => {
  const fixes = sweepMarkdownWithFixes('a a b\n\nc c d\n').fixes;
  const params = buildApplyEditParams(fixes, { uri: 'file:///note.md', version: 3 });

  assert.equal(params.label, 'Visions: 2 silent fixes');
  assert.equal(params.edit.documentChanges.length, 1, 'one document, one change entry');
  assert.deepEqual(params.edit.documentChanges[0].textDocument, { uri: 'file:///note.md', version: 3 });
  assert.deepEqual(params.edit.documentChanges[0].edits, fixes.map((fix) => ({ range: fix.editRange, newText: '' })));
  assert.equal(buildApplyEditParams([fixes[0]], { uri: 'file:///note.md', version: 3 }).label, 'Visions: 1 silent fix');
});

test('a stored fix set is served only against the hash it was swept from', () => {
  const entry = { fixes: [], textHash: '1a-2b' };
  assert.equal(isFixSetFresh(entry, '1a-2b'), true);
  assert.equal(isFixSetFresh(entry, '1a-2c'), false, 'one keystroke and the set is stale');
  assert.equal(isFixSetFresh(undefined, '1a-2b'), false);
  assert.equal(isFixSetFresh(entry, ''), false);
});

test('a changelog entry keeps the zero-based line and answers applied or refused', () => {
  const [fix] = sweepMarkdownWithFixes(REPEAT_TEXT).fixes;
  const applied = fixLogEntry({
    uri: 'file:///note.md', fix, applied: true, ts: 1700000000000,
  });
  assert.deepEqual(applied, {
    uri: 'file:///note.md',
    code: 'repeated-word',
    line: 2,
    message: 'Repeated word "with"',
    applied: true,
    ts: 1700000000000,
  });
  assert.equal(fixLogEntry({ uri: 'file:///note.md', fix, applied: 'yes', ts: 1 }).applied, false, 'only a real true is applied');
  assert.deepEqual(fixPayload(applied), {
    code: 'repeated-word', line: 2, message: 'Repeated word "with"', applied: true,
  });
});

test('the changelog is newest first and capped, so an unattended lane cannot grow it without end', () => {
  let ring = [];
  for (let index = 0; index < 25; index++) {
    ring = appendFixLog(ring, { code: 'repeated-word', line: index, applied: true }, 20);
  }
  assert.equal(ring.length, 20);
  assert.equal(ring[0].line, 24, 'newest first');
  assert.equal(ring[19].line, 5, 'and the oldest five are gone');
  assert.equal(appendFixLog([], { line: 0 }).length, 1);
});
