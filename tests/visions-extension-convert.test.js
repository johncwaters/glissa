'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const vscode = require('./helpers/vscode-stub.ts').default;
const {
  decideEditFreshness, toCodeActions, toDiagnostics, toWorkspaceEdit,
} = require('../tools/vscode-visions/lsp-convert.ts');

test('a published diagnostic keeps its range, code and source', () => {
  const [diagnostic] = toDiagnostics(vscode, [{
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
    message: 'Fence is not closed',
    severity: 2,
    code: 'unclosed-fence',
    source: 'glissa-visions',
  }]);
  assert.equal(diagnostic.message, 'Fence is not closed');
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
  assert.equal(diagnostic.range.start.line, 2);
  assert.equal(diagnostic.range.start.character, 4);
  assert.equal(diagnostic.code, 'unclosed-fence');
  assert.equal(diagnostic.source, 'glissa-visions');
});

test('a malformed diagnostic degrades instead of throwing', () => {
  const [diagnostic] = toDiagnostics(vscode, [{}]);
  assert.equal(diagnostic.range.start.line, 0);
  assert.equal(diagnostic.range.start.character, 0);
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
  assert.deepEqual(toDiagnostics(vscode, null), []);
});

test('a workspace edit becomes one replacement per text edit', () => {
  const edit = toWorkspaceEdit(vscode, {
    documentChanges: [{
      textDocument: { uri: 'file:///plan.md', version: 7 },
      edits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'the' },
        { range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } }, newText: '' },
      ],
    }],
  });
  assert.equal(edit.replacements.length, 2);
  assert.equal(edit.replacements[0].uri, 'file:///plan.md');
  assert.equal(edit.replacements[0].newText, 'the');
  assert.equal(edit.replacements[1].newText, '');
});

test('a code action carries its quick fix kind, edit and diagnostics', () => {
  const [action] = toCodeActions(vscode, [{
    title: 'Visions: remove repeated word',
    kind: 'quickfix',
    diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'repeated word' }],
    edit: { documentChanges: [{ textDocument: { uri: 'file:///plan.md', version: 3 }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: '' }] }] },
  }]);
  assert.equal(action.title, 'Visions: remove repeated word');
  assert.equal(action.kind, vscode.CodeActionKind.QuickFix);
  assert.equal(action.edit.replacements.length, 1);
  assert.equal(action.diagnostics.length, 1);
  assert.deepEqual(toCodeActions(vscode, null), []);
});

test('an edit against a moved buffer is refused, a null version is not checked', () => {
  const versions = { 'file:///plan.md': 9 };
  const versionOf = (uri) => (uri in versions ? versions[uri] : null);
  const editAt = (version) => ({ documentChanges: [{ textDocument: { uri: 'file:///plan.md', version }, edits: [] }] });

  assert.equal(decideEditFreshness(editAt(9), versionOf).fresh, true);
  assert.equal(decideEditFreshness(editAt(8), versionOf).reason, 'stale-version');
  assert.equal(decideEditFreshness(editAt(null), versionOf).fresh, true);
  assert.equal(decideEditFreshness({ documentChanges: [] }, versionOf).reason, 'no-document-changes');
  assert.equal(decideEditFreshness(editAt(8), () => null).fresh, true);
});
