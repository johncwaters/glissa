import { deepestRootFor, normalizeShapePath, pathOfFileUri } from './visions-scope-core.ts';

const SOURCE = 'editor';

const ACTIVITY_METHOD = 'visions/editorActivity';
const KIND_BY_METHOD: Readonly<Record<string, string>> = Object.freeze({
  'textDocument/didOpen': 'doc-open',
  'textDocument/didSave': 'doc-save',
  'textDocument/didClose': 'doc-close',
});
const VERB_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
  'doc-open': 'opened',
  'doc-save': 'saved',
  'doc-close': 'closed',
});

export interface EditorNotification {
  method?: string;
  uri?: string;
  roots?: string[];
  now?: number;
}

export interface EditorState {
  openUris: Set<string>;
}

export type EditorEvent = {
  source: string;
  kind: string;
  ts: number;
  scope: { root: string | null; sessionId: string | null };
  summary: string;
  detail: { path: string };
}

function createEditorState(): EditorState {
  return { openUris: new Set() };
}

function relativeTo(root: string | null | undefined, normalizedPath: string): string {
  if (!root || root === normalizedPath) return normalizedPath.split('/').pop() || normalizedPath;
  return normalizedPath.slice(root.length + 1);
}

function applyEditorNotification(
  state: EditorState,
  { method, uri, roots = [], now = 0 }: EditorNotification = {},
): { state: EditorState; event: EditorEvent | null } {
  if (typeof method !== 'string' || typeof uri !== 'string') return { state, event: null };
  const kind = KIND_BY_METHOD[method];
  if (!kind) return { state, event: null };
  const normalizedPath = normalizeShapePath(pathOfFileUri(uri));
  if (!normalizedPath) return { state, event: null };

  if (kind === 'doc-open' && state.openUris.has(uri)) return { state, event: null };
  if (kind === 'doc-close' && !state.openUris.has(uri)) return { state, event: null };
  if (kind === 'doc-open') state.openUris.add(uri);
  if (kind === 'doc-close') state.openUris.delete(uri);

  const root = deepestRootFor(normalizedPath, roots);
  return {
    state,
    event: {
      source: SOURCE,
      kind,
      ts: now,
      scope: { root: root || null, sessionId: null },
      summary: `${VERB_BY_KIND[kind]} ${relativeTo(root, normalizedPath)}`,
      detail: { path: relativeTo(root, normalizedPath) },
    },
  };
}

export { ACTIVITY_METHOD, SOURCE, applyEditorNotification, createEditorState };
