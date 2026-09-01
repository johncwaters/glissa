// The `vscode` namespace is an argument rather than a require, so these run under node:test against a
// stub (tests/helpers/vscode-stub.js); the extension host is the one runtime the suite cannot boot.
//
// Authored CommonJS-style on purpose: `server/visions-setup.ts` strips the types and packs the result
// under the .js name the extension host loads, and that host has no ESM loader and no type stripping.

interface VscodePosition {
  line: number;
  character: number;
}

interface VscodeRange {
  start: VscodePosition;
  end: VscodePosition;
}

interface VscodeUri {
  toString(): string;
}

interface VscodeDiagnostic {
  range: VscodeRange;
  message: string;
  severity: unknown;
  code?: unknown;
  source?: string;
}

interface VscodeWorkspaceEdit {
  replace(uri: VscodeUri, range: VscodeRange, newText: string): void;
}

interface VscodeCodeAction {
  title: string;
  kind: unknown;
  edit?: VscodeWorkspaceEdit;
  diagnostics?: VscodeDiagnostic[];
}

interface VscodeApi {
  Position: new (line: number, character: number) => VscodePosition;
  Range: new (start: VscodePosition, end: VscodePosition) => VscodeRange;
  Diagnostic: new (range: VscodeRange, message: string, severity: unknown) => VscodeDiagnostic;
  CodeAction: new (title: string, kind: unknown) => VscodeCodeAction;
  WorkspaceEdit: new () => VscodeWorkspaceEdit;
  Uri: { parse(value: string): VscodeUri };
  DiagnosticSeverity: Record<string, unknown>;
  CodeActionKind: { QuickFix: unknown };
}

interface LspPosition {
  line?: number;
  character?: number;
}

interface LspRange {
  start?: LspPosition;
  end?: LspPosition;
}

interface LspDiagnostic {
  range?: LspRange;
  message?: string;
  severity?: number;
  code?: unknown;
  source?: string;
}

interface LspTextEdit {
  range?: LspRange;
  newText?: string;
}

interface LspTextDocumentIdentifier {
  uri?: string;
  version?: number | null;
}

interface LspDocumentChange {
  textDocument?: LspTextDocumentIdentifier;
  edits?: LspTextEdit[];
}

interface IdentifiedDocumentChange extends LspDocumentChange {
  textDocument: LspTextDocumentIdentifier & { uri: string };
}

interface LspWorkspaceEdit {
  documentChanges?: LspDocumentChange[];
}

interface LspCodeAction {
  title?: string;
  edit?: LspWorkspaceEdit;
  diagnostics?: LspDiagnostic[];
}

interface EditFreshness {
  fresh: boolean;
  reason: string;
}

type VersionLookup = (uri: string) => number | null | undefined;

const SEVERITY_BY_LSP: Record<number, string> = { 1: 'Error', 2: 'Warning', 3: 'Information', 4: 'Hint' };

function toPosition(vscodeApi: VscodeApi, position: LspPosition | undefined): VscodePosition {
  const line = Number.isInteger(position?.line) ? Number(position?.line) : 0;
  const character = Number.isInteger(position?.character) ? Number(position?.character) : 0;
  return new vscodeApi.Position(line, character);
}

function toRange(vscodeApi: VscodeApi, range: LspRange | undefined): VscodeRange {
  return new vscodeApi.Range(toPosition(vscodeApi, range?.start), toPosition(vscodeApi, range?.end));
}

function toDiagnostic(vscodeApi: VscodeApi, diagnostic: LspDiagnostic | undefined): VscodeDiagnostic {
  const converted = new vscodeApi.Diagnostic(
    toRange(vscodeApi, diagnostic?.range),
    typeof diagnostic?.message === 'string' ? diagnostic.message : '',
    vscodeApi.DiagnosticSeverity[SEVERITY_BY_LSP[Number(diagnostic?.severity)] || 'Warning'],
  );
  if (diagnostic?.code !== undefined) converted.code = diagnostic.code;
  if (typeof diagnostic?.source === 'string') converted.source = diagnostic.source;
  return converted;
}

function toDiagnostics(vscodeApi: VscodeApi, diagnostics: unknown): VscodeDiagnostic[] {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.map((diagnostic) => toDiagnostic(vscodeApi, diagnostic));
}

function documentChangesOf(edit: LspWorkspaceEdit | null | undefined): IdentifiedDocumentChange[] {
  const changes = edit?.documentChanges;
  if (!Array.isArray(changes)) return [];
  return changes.filter((change): change is IdentifiedDocumentChange => typeof change?.textDocument?.uri === 'string');
}

function toWorkspaceEdit(vscodeApi: VscodeApi, edit: LspWorkspaceEdit | null | undefined): VscodeWorkspaceEdit {
  const workspaceEdit = new vscodeApi.WorkspaceEdit();
  for (const change of documentChangesOf(edit)) {
    const uri = vscodeApi.Uri.parse(change.textDocument.uri);
    for (const textEdit of Array.isArray(change.edits) ? change.edits : []) {
      workspaceEdit.replace(uri, toRange(vscodeApi, textEdit?.range), typeof textEdit?.newText === 'string' ? textEdit.newText : '');
    }
  }
  return workspaceEdit;
}

function toCodeAction(vscodeApi: VscodeApi, action: LspCodeAction | undefined): VscodeCodeAction {
  const converted = new vscodeApi.CodeAction(
    typeof action?.title === 'string' ? action.title : 'Visions fix',
    vscodeApi.CodeActionKind.QuickFix,
  );
  if (action?.edit) converted.edit = toWorkspaceEdit(vscodeApi, action.edit);
  const diagnostics = action?.diagnostics;
  if (Array.isArray(diagnostics)) converted.diagnostics = toDiagnostics(vscodeApi, diagnostics);
  return converted;
}

function toCodeActions(vscodeApi: VscodeApi, actions: unknown): VscodeCodeAction[] {
  if (!Array.isArray(actions)) return [];
  return actions.map((action) => toCodeAction(vscodeApi, action));
}

// A versioned edit answers for the buffer it was computed from, so a stale one is REFUSED rather than
// landing on text the carbon unit has since typed into (`server/core/visions-fix-core.ts`).
function decideEditFreshness(edit: LspWorkspaceEdit | null | undefined, versionOfUri: VersionLookup): EditFreshness {
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
