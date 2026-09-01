// The `vscode` namespace is an argument rather than a require, so these run under node:test against a
// stub (tests/helpers/vscode-stub.js); the extension host is the one runtime the suite cannot boot.

'use strict';

const SEVERITY_BY_LSP = { 1: 'Error', 2: 'Warning', 3: 'Information', 4: 'Hint' };

function toPosition(vscodeApi, position) {
  const line = Number.isInteger(position?.line) ? position.line : 0;
  const character = Number.isInteger(position?.character) ? position.character : 0;
  return new vscodeApi.Position(line, character);
}

function toRange(vscodeApi, range) {
  return new vscodeApi.Range(toPosition(vscodeApi, range?.start), toPosition(vscodeApi, range?.end));
}

function toDiagnostic(vscodeApi, diagnostic) {
  const converted = new vscodeApi.Diagnostic(
    toRange(vscodeApi, diagnostic?.range),
    typeof diagnostic?.message === 'string' ? diagnostic.message : '',
    vscodeApi.DiagnosticSeverity[SEVERITY_BY_LSP[diagnostic?.severity] || 'Warning'],
  );
  if (diagnostic?.code !== undefined) converted.code = diagnostic.code;
  if (typeof diagnostic?.source === 'string') converted.source = diagnostic.source;
  return converted;
}

function toDiagnostics(vscodeApi, diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.map((diagnostic) => toDiagnostic(vscodeApi, diagnostic));
}

function documentChangesOf(edit) {
  if (!Array.isArray(edit?.documentChanges)) return [];
  return edit.documentChanges.filter((change) => typeof change?.textDocument?.uri === 'string');
}

function toWorkspaceEdit(vscodeApi, edit) {
  const workspaceEdit = new vscodeApi.WorkspaceEdit();
  for (const change of documentChangesOf(edit)) {
    const uri = vscodeApi.Uri.parse(change.textDocument.uri);
    for (const textEdit of Array.isArray(change.edits) ? change.edits : []) {
      workspaceEdit.replace(uri, toRange(vscodeApi, textEdit?.range), typeof textEdit?.newText === 'string' ? textEdit.newText : '');
    }
  }
  return workspaceEdit;
}

function toCodeAction(vscodeApi, action) {
  const converted = new vscodeApi.CodeAction(
    typeof action?.title === 'string' ? action.title : 'Visions fix',
    vscodeApi.CodeActionKind.QuickFix,
  );
  if (action?.edit) converted.edit = toWorkspaceEdit(vscodeApi, action.edit);
  if (Array.isArray(action?.diagnostics)) converted.diagnostics = toDiagnostics(vscodeApi, action.diagnostics);
  return converted;
}

function toCodeActions(vscodeApi, actions) {
  if (!Array.isArray(actions)) return [];
  return actions.map((action) => toCodeAction(vscodeApi, action));
}

// A versioned edit answers for the buffer it was computed from, so a stale one is REFUSED rather than
// landing on text the carbon unit has since typed into (`server/core/visions-fix-core.ts`).
function decideEditFreshness(edit, versionOfUri) {
  const changes = documentChangesOf(edit);
  if (changes.length === 0) return { fresh: false, reason: 'no-document-changes' };
  for (const change of changes) {
    const expected = change.textDocument.version;
    if (expected === null || expected === undefined) continue;
    const current = versionOfUri(change.textDocument.uri);
    if (current === null || current === undefined) continue;
    if (current !== expected) return { fresh: false, reason: 'stale-version' };
  }
  return { fresh: true, reason: 'ok' };
}

module.exports = {
  decideEditFreshness,
  toCodeAction,
  toCodeActions,
  toDiagnostic,
  toDiagnostics,
  toRange,
  toWorkspaceEdit,
};
