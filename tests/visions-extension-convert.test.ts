import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import vscode from './helpers/vscode-stub.ts';

type StubApi = typeof vscode;
type StubWorkspaceEdit = InstanceType<StubApi['WorkspaceEdit']>;
type StubDiagnostic = InstanceType<StubApi['Diagnostic']> & { code?: unknown; source?: string };
type StubCodeAction = InstanceType<StubApi['CodeAction']> & {
  edit?: StubWorkspaceEdit;
  diagnostics?: StubDiagnostic[];
};

interface LspPosition {
  line?: number;
  character?: number;
}

interface LspRange {
  start?: LspPosition;
  end?: LspPosition;
}

interface LspWorkspaceEdit {
  documentChanges?: {
    textDocument?: { uri?: string; version?: number | null };
    edits?: { range?: LspRange; newText?: string }[];
  }[];
}

interface LspConvert {
  toDiagnostics(api: StubApi, diagnostics: unknown): StubDiagnostic[];
  toWorkspaceEdit(api: StubApi, edit: LspWorkspaceEdit | null | undefined): StubWorkspaceEdit;
  toCodeActions(api: StubApi, actions: unknown): StubCodeAction[];
  decideEditFreshness(
    edit: LspWorkspaceEdit | null | undefined,
    versionOfUri: (uri: string) => number | null | undefined,
  ): { fresh: boolean; reason: string };
}

const { decideEditFreshness, toCodeActions, toDiagnostics, toWorkspaceEdit }: LspConvert =
  createRequire(import.meta.url)('../tools/vscode-visions/lsp-convert.ts');

function firstOf<T>(items: T[], what: string): T {
  const first = items[0];
  if (first === undefined) throw new Error(`expected at least one ${what}`);
  return first;
}

test('a published diagnostic keeps its range, code and source', () => {
  const diagnostic = firstOf(toDiagnostics(vscode, [{
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
    message: 'Fence is not closed',
    severity: 2,
    code: 'unclosed-fence',
    source: 'glissa-visions',
  }]), 'diagnostic');
  assert.equal(diagnostic.message, 'Fence is not closed');
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
  assert.equal(diagnostic.range.start.line, 2);
  assert.equal(diagnostic.range.start.character, 4);
  assert.equal(diagnostic.code, 'unclosed-fence');
  assert.equal(diagnostic.source, 'glissa-visions');
});

test('a malformed diagnostic degrades instead of throwing', () => {
  const diagnostic = firstOf(toDiagnostics(vscode, [{}]), 'diagnostic');
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
  assert.equal(edit.replacements[0]?.uri, 'file:///plan.md');
  assert.equal(edit.replacements[0]?.newText, 'the');
  assert.equal(edit.replacements[1]?.newText, '');
});

test('a code action carries its quick fix kind, edit and diagnostics', () => {
  const action = firstOf(toCodeActions(vscode, [{
    title: 'Visions: remove repeated word',
    kind: 'quickfix',
    diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'repeated word' }],
    edit: { documentChanges: [{ textDocument: { uri: 'file:///plan.md', version: 3 }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: '' }] }] },
  }]), 'code action');
  assert.equal(action.title, 'Visions: remove repeated word');
  assert.equal(action.kind, vscode.CodeActionKind.QuickFix);
  assert.equal(action.edit?.replacements.length, 1);
  assert.equal(action.diagnostics?.length, 1);
  assert.deepEqual(toCodeActions(vscode, null), []);
});

test('an edit against a moved buffer is refused, a null version is not checked', () => {
  const versions: Record<string, number> = { 'file:///plan.md': 9 };
  const versionOf = (uri: string): number | null => versions[uri] ?? null;
  const editAt = (version: number | null): LspWorkspaceEdit => ({
    documentChanges: [{ textDocument: { uri: 'file:///plan.md', version }, edits: [] }],
  });

  assert.equal(decideEditFreshness(editAt(9), versionOf).fresh, true);
  assert.equal(decideEditFreshness(editAt(8), versionOf).reason, 'stale-version');
  assert.equal(decideEditFreshness(editAt(null), versionOf).fresh, true);
  assert.equal(decideEditFreshness({ documentChanges: [] }, versionOf).reason, 'no-document-changes');
  assert.equal(decideEditFreshness(editAt(8), () => null).fresh, true);
});
