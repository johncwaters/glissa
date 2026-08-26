'use strict';

// Stands in for the `vscode` module the extension host injects, so tools/vscode-visions runs under
// node:test. Only the surface the extension actually touches exists here; `__test` is the control
// side (recorded diagnostics, fired events, the settings the extension reads).

const { EventEmitter } = require('node:events');

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}

class WorkspaceEdit {
  constructor() {
    this.replacements = [];
  }

  replace(uri, range, newText) {
    this.replacements.push({ uri: String(uri), range, newText });
  }
}

function parseUri(value) {
  return { toString: () => String(value), fsPath: String(value) };
}

const emitter = new EventEmitter();
const state = {
  diagnosticsByUri: new Map(),
  documents: [],
  settings: { relayPath: '', port: 0 },
  appliedEdits: [],
  applyEditResult: true,
  output: [],
  codeActionProviders: [],
  errors: [],
};

function listener(eventName) {
  return (handler) => {
    emitter.on(eventName, handler);
    return { dispose: () => emitter.off(eventName, handler) };
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
      append: (text) => state.output.push(text),
      appendLine: (text) => state.output.push(text),
      dispose: () => {},
    }),
    showErrorMessage: (message) => state.errors.push(message),
  },
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri, diagnostics) => state.diagnosticsByUri.set(String(uri), diagnostics),
      delete: (uri) => state.diagnosticsByUri.delete(String(uri)),
      clear: () => state.diagnosticsByUri.clear(),
      dispose: () => {},
    }),
    registerCodeActionsProvider: (selector, provider) => {
      state.codeActionProviders.push({ selector, provider });
      return { dispose: () => {} };
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (state.settings[key] === undefined ? fallback : state.settings[key]),
    }),
    get textDocuments() {
      return state.documents;
    },
    applyEdit: async (edit) => {
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
    fire: (eventName, payload) => emitter.emit(eventName, payload),
    reset() {
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
    document({ uri, text, version = 1, languageId = 'markdown' }) {
      return {
        uri: parseUri(uri),
        languageId,
        version,
        getText: () => text,
      };
    },
  },
};

module.exports = vscode;
