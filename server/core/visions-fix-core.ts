/*
 * Pure decisions for the Visions lane's tier 1 silent fixes (docs/archive/plan-navigator-2.md, M6): which fixes may
 * be applied without asking, which of them a codeAction request is asking about, what the LSP payloads
 * carrying them look like, and when a stored fix set has gone stale. No IO, no clock, no timers.
 */

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

/*
 * The whole auto-safe judgement, in one place. A deleted repeated word is recoverable by undo and cannot
 * mean anything other than what it says; every other detector either guesses a position (unclosed-fence)
 * or would rewrite structure, so it stays pull-only and the carbon unit asks for it.
 */
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

/*
 * A sweep reports either an array of diagnostics (every caller before M6, and any sweep a test injects)
 * or both halves. Reading it here keeps the wiring from having to know which kind it was handed.
 */
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

/*
 * Inclusive at both ends, so a bare cursor (a zero-width selection) sitting against a finding still
 * offers its fix. An editor asks with whatever the caret happens to be touching, and a quick fix the
 * carbon unit can see but not select would read as the lane being broken.
 */
function rangesOverlap(left: DocumentRange | null | undefined, right: DocumentRange | null | undefined): boolean {
  const first = readRange(left);
  const second = readRange(right);
  if (!first || !second) return false;
  if (comparePositions(first.end, second.start) < 0) return false;
  if (comparePositions(second.end, first.start) < 0) return false;
  return true;
}

// An absent or malformed range means the editor asked about the whole document, never about nothing.
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

// The diagnostic the fix answers, rebuilt from what the fix carries so a code action can point at it.
function diagnosticOfFix(fix: SweepFix | null | undefined) {
  return {
    range: fix?.range,
    severity: WARNING,
    source: SOURCE,
    code: fix?.code,
    message: fix?.message,
  };
}

/*
 * Versioned by construction, in both payload builders: an edit computed against a buffer the carbon unit
 * has since typed into is REFUSED by the editor rather than landing on moved text. A version that is not
 * a number becomes null, which is the LSP way of saying the client should not check.
 */
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

// A fix set describes exactly one buffer state, so it is served only against the hash it was swept from.
function isFixSetFresh(entry: { textHash?: unknown } | null | undefined, textHash: unknown): boolean {
  if (!entry || typeof textHash !== 'string' || !textHash) return false;
  return entry.textHash === textHash;
}

function lineOfFix(fix: SweepFix | null | undefined): number {
  const line = Number(fix?.range?.start?.line);
  return Number.isFinite(line) && line > 0 ? Math.floor(line) : 0;
}

// The changelog record, LSP-zero-based like the diagnostic it came from; the tab does the +1.
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

// What one broadcast says about one fix, beside the uri and ts the frame already carries.
function fixPayload(entry: FixLogEntry) {
  return {
    code: entry.code, line: entry.line, message: entry.message, applied: entry.applied,
  };
}

// Newest first, so the ring is what the tab renders rather than something it has to reverse.
function appendFixLog<T>(ring: unknown, entry: T, max: unknown = DEFAULT_FIX_LOG_MAX): T[] {
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : DEFAULT_FIX_LOG_MAX;
  return [entry, ...listOf<T>(ring)].slice(0, cap);
}

export { AUTO_SAFE_CODES, DEFAULT_FIX_LOG_MAX, QUICKFIX_KIND, appendFixLog, applyEditLabel, autoSafeFixes, buildApplyEditParams, buildCodeActions, filterFixesByRange, fixLogEntry, fixPayload, fixTitle, isAutoSafeFix, isFixSetFresh, rangesOverlap, readSweepResult };
