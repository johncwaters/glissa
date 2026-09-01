import type { DocumentRange, SweepDiagnostic, SweepFix } from './visions-rules-core.ts';
import { SOURCE, WARNING } from './visions-rules-core.ts';

export interface FixLogEntry {
  uri: string;
  code: string;
  line: number;
  message: string;
  applied: boolean;
  ts: number;
}

const AUTO_SAFE_CODES = Object.freeze(['repeated-word']);
const QUICKFIX_KIND = 'quickfix';
const DEFAULT_FIX_LOG_MAX = 20;

const FIX_TITLES: Record<string, string> = {
  'repeated-word': 'Delete the repeated word',
  'unclosed-fence': 'Close the fence at the end of the document',
};

function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isAutoSafeFix(fix: { code?: string } | null | undefined): boolean {
  return !!fix && AUTO_SAFE_CODES.includes(fix.code as string);
}

function autoSafeFixes(fixes: unknown): SweepFix[] {
  return listOf<SweepFix>(fixes).filter(isAutoSafeFix);
}

function readSweepResult(result: unknown): { diagnostics: SweepDiagnostic[]; fixes: SweepFix[] } {
  if (Array.isArray(result)) return { diagnostics: result as SweepDiagnostic[], fixes: [] };
  if (!result || typeof result !== 'object') return { diagnostics: [], fixes: [] };
  const fields = result as { diagnostics?: unknown; fixes?: unknown };
  return { diagnostics: listOf<SweepDiagnostic>(fields.diagnostics), fixes: listOf<SweepFix>(fields.fixes) };
}

function positionValue(position: { line?: unknown; character?: unknown } | null | undefined): { line: number; character: number } | null {
  const line = Number(position?.line);
  const character = Number(position?.character);
  if (!Number.isFinite(line) || !Number.isFinite(character)) return null;
  return { line, character };
}

function comparePositions(left: { line: number; character: number }, right: { line: number; character: number }): number {
  if (left.line !== right.line) return left.line - right.line;
  return left.character - right.character;
}

function readRange(range: DocumentRange | null | undefined): DocumentRange | null {
  const start = positionValue(range?.start);
  const end = positionValue(range?.end);
  if (!start || !end) return null;
  return { start, end };
}

function rangesOverlap(left: DocumentRange | null | undefined, right: DocumentRange | null | undefined): boolean {
  const first = readRange(left);
  const second = readRange(right);
  if (!first || !second) return false;
  if (comparePositions(first.end, second.start) < 0) return false;
  if (comparePositions(second.end, first.start) < 0) return false;
  return true;
}

function filterFixesByRange(fixes: unknown, range: DocumentRange | null | undefined): SweepFix[] {
  const requested = readRange(range);
  if (!requested) return listOf<SweepFix>(fixes);
  return listOf<SweepFix>(fixes).filter((fix) => rangesOverlap(fix?.range, requested));
}

function fixTitle(fix: SweepFix | null | undefined): string {
  const code = fix?.code;
  const titled = code == null ? undefined : FIX_TITLES[code];
  return titled || (fix?.message ? String(fix.message) : 'Apply the Visions fix');
}

function diagnosticOfFix(fix: SweepFix | null | undefined) {
  return {
    range: fix?.range,
    severity: WARNING,
    source: SOURCE,
    code: fix?.code,
    message: fix?.message,
  };
}

function versionedIdentifier(uri: string | undefined, version: unknown) {
  const value = Number(version);
  return { uri, version: Number.isFinite(value) ? Math.floor(value) : null };
}

function textEditOf(fix: SweepFix | null | undefined) {
  return { range: fix?.editRange, newText: typeof fix?.newText === 'string' ? fix.newText : '' };
}

function workspaceEdit(fixes: unknown, { uri, version }: { uri?: string; version?: unknown }) {
  return {
    documentChanges: [{
      textDocument: versionedIdentifier(uri, version),
      edits: listOf<SweepFix>(fixes).map(textEditOf),
    }],
  };
}

function buildCodeActions(fixes: unknown, { uri, version }: { uri?: string; version?: unknown } = {}) {
  return listOf<SweepFix>(fixes).map((fix) => ({
    title: fixTitle(fix),
    kind: QUICKFIX_KIND,
    diagnostics: [diagnosticOfFix(fix)],
    edit: workspaceEdit([fix], { uri, version }),
  }));
}

function applyEditLabel(count: number): string {
  return count === 1 ? 'Visions: 1 silent fix' : `Visions: ${count} silent fixes`;
}

function buildApplyEditParams(fixes: unknown, { uri, version }: { uri?: string; version?: unknown } = {}) {
  const batch = listOf<SweepFix>(fixes);
  return { label: applyEditLabel(batch.length), edit: workspaceEdit(batch, { uri, version }) };
}

function isFixSetFresh(entry: { textHash?: unknown } | null | undefined, textHash: unknown): boolean {
  if (!entry || typeof textHash !== 'string' || !textHash) return false;
  return entry.textHash === textHash;
}

function lineOfFix(fix: SweepFix | null | undefined): number {
  const line = Number(fix?.range?.start?.line);
  return Number.isFinite(line) && line > 0 ? Math.floor(line) : 0;
}

function fixLogEntry({ uri, fix, applied, ts }: {
  uri?: unknown;
  fix?: SweepFix | null;
  applied?: unknown;
  ts?: unknown;
}): FixLogEntry {
  return {
    uri: typeof uri === 'string' ? uri : '',
    code: fix?.code == null ? '' : String(fix.code),
    line: lineOfFix(fix),
    message: fix?.message == null ? '' : String(fix.message),
    applied: applied === true,
    ts: Number.isFinite(Number(ts)) ? Number(ts) : 0,
  };
}

function fixPayload(entry: FixLogEntry) {
  return {
    code: entry.code, line: entry.line, message: entry.message, applied: entry.applied,
  };
}

function appendFixLog<T>(ring: unknown, entry: T, max: unknown = DEFAULT_FIX_LOG_MAX): T[] {
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : DEFAULT_FIX_LOG_MAX;
  return [entry, ...listOf<T>(ring)].slice(0, cap);
}

export { AUTO_SAFE_CODES, DEFAULT_FIX_LOG_MAX, QUICKFIX_KIND, appendFixLog, applyEditLabel, autoSafeFixes, buildApplyEditParams, buildCodeActions, filterFixesByRange, fixLogEntry, fixPayload, fixTitle, isAutoSafeFix, isFixSetFresh, rangesOverlap, readSweepResult };
