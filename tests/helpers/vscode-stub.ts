import { EventEmitter } from 'node:events';

interface StubPosition {
  line: number;
  character: number;
}

interface StubRange {
  start: StubPosition;
  end: StubPosition;
}

interface StubUri {
  toString(): string;
  fsPath: string;
  scheme: string;
}

interface StubReplacement {
  uri: string;
  range: StubRange;
  newText: string;
}

interface StubDocument {
  uri: StubUri;
  languageId: string;
  version: number;
  getText(): string;
}

interface StubDisposable {
  dispose(): void;
}

interface StubCodeActionProvider {
  selector: unknown;
  provider: unknown;
}

interface StubState {
  diagnosticsByUri: Map<string, unknown[]>;
  documents: StubDocument[];
  settings: Record<string, unknown>;
  appliedEdits: WorkspaceEdit[];
  applyEditResult: boolean;
  output: string[];
  codeActionProviders: StubCodeActionProvider[];
  errors: string[];
}

class Position implements StubPosition {
  line: number;
  character: number;

  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

class Range implements StubRange {
  start: StubPosition;
  end: StubPosition;

  constructor(start: StubPosition, end: StubPosition) {
    this.start = start;
    this.end = end;
  }
}

class Diagnostic {
  range: StubRange;
  message: string;
  severity: unknown;

  constructor(range: StubRange, message: string, severity: unknown) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

class CodeAction {
  title: string;
  kind: unknown;

  constructor(title: string, kind: unknown) {
    this.title = title;
    this.kind = kind;
  }
}

class WorkspaceEdit {
  replacements: StubReplacement[];

  constructor() {
    this.replacements = [];
  }

  replace(uri: StubUri | string, range: StubRange, newText: string): void {
    this.replacements.push({ uri: String(uri), range, newText });
  }
}

function parseUri(value: string): StubUri {
  const text = String(value);
  const scheme = text.includes(':') ? text.slice(0, text.indexOf(':')) : 'file';
  return { toString: () => text, fsPath: text, scheme };
}

const emitter = new EventEmitter();
const state: StubState = {
  diagnosticsByUri: new Map(),
  documents: [],
  settings: { relayPath: '', port: 0 },
  appliedEdits: [],
  applyEditResult: true,
  output: [],
  codeActionProviders: [],
  errors: [],
};

function listener(eventName: string) {
  return (handler: (payload: unknown) => void): StubDisposable => {
    emitter.on(eventName, handler);
    return { dispose: () => { emitter.off(eventName, handler); } };
  };
}

const vscode = {
  Position,
  Range,
  Diagnostic,
  CodeAction,
  WorkspaceEdit,
  Uri: { parse: parseUri },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  CodeActionKind: { QuickFix: 'quickfix' },
  window: {
    createOutputChannel: () => ({
      append: (text: string) => state.output.push(text),
      appendLine: (text: string) => state.output.push(text),
      dispose: () => {},
    }),
    showErrorMessage: (message: string) => state.errors.push(message),
  },
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri: StubUri | string, diagnostics: unknown[]) => state.diagnosticsByUri.set(String(uri), diagnostics),
      delete: (uri: StubUri | string) => state.diagnosticsByUri.delete(String(uri)),
      clear: () => state.diagnosticsByUri.clear(),
      dispose: () => {},
    }),
    registerCodeActionsProvider: (selector: unknown, provider: unknown): StubDisposable => {
      state.codeActionProviders.push({ selector, provider });
      return { dispose: () => {} };
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (state.settings[key] === undefined ? fallback : state.settings[key]),
    }),
    get textDocuments(): StubDocument[] {
      return state.documents;
    },
    applyEdit: async (edit: WorkspaceEdit) => {
      state.appliedEdits.push(edit);
      return state.applyEditResult;
    },
    onDidOpenTextDocument: listener('open'),
    onDidChangeTextDocument: listener('change'),
    onDidSaveTextDocument: listener('save'),
    onDidCloseTextDocument: listener('close'),
  },
  __test: {
    state,
    fire: (eventName: string, payload: unknown) => emitter.emit(eventName, payload),
    reset(): void {
      emitter.removeAllListeners();
      state.diagnosticsByUri.clear();
      state.documents = [];
      state.settings = { relayPath: '', port: 0 };
      state.appliedEdits = [];
      state.applyEditResult = true;
      state.output = [];
      state.codeActionProviders = [];
      state.errors = [];
    },
    document({ uri, text, version = 1, languageId = 'markdown' }: {
      uri: string;
      text: string;
      version?: number;
      languageId?: string;
    }): StubDocument {
      return {
        uri: parseUri(uri),
        languageId,
        version,
        getText: () => text,
      };
    },
  },
};

export default vscode;
export type { StubDocument, StubState, StubUri };
