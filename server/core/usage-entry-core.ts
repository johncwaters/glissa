import path from 'node:path';
import { numberOrNull, safeNumber, stringOrNull } from './usage-number-core.ts';

const NULL_REJECT_FIELDS = Object.freeze([
  ['id'],
  ['cwd'],
  ['version'],
  ['costUSD'],
  ['sessionId'],
  ['requestId'],
  ['isApiErrorMessage'],
  ['message', 'id'],
  ['message', 'model'],
  ['message', 'usage', 'speed'],
  ['message', 'usage', 'costUSD'],
  ['message', 'usage', 'cache_read_input_tokens'],
  ['message', 'usage', 'cache_creation_input_tokens'],
]);

export interface TokenCountsSource {
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
  costUSD?: number | null;
}

export interface UsageEntryLike extends TokenCountsSource {
  timestamp?: string;
  timestampMs: number;
  cwd?: string | null;
  project?: string | null;
  file?: string | null;
  version?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  messageId?: string | null;
  model?: string | null;
  rawModel?: string | null;
  speed?: string | null;
  isSidechain?: boolean;
  isAdvisor?: boolean;
  vendor?: string;
  cacheCreation5m?: number;
  cacheCreation1h?: number;
  iterations?: unknown[];
}

// Everything a parsed entry always carries: the loose shape above is what partial rows (a warehouse
// record, a report's model row) satisfy.
export interface UsageEntry extends UsageEntryLike {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  costUSD: number | null;
}

export interface DedupIdentityEntry {
  vendor?: unknown;
  sessionId?: unknown;
  messageId?: unknown;
  timestampMs?: unknown;
  model?: unknown;
  input?: unknown;
  output?: unknown;
  cacheCreate?: unknown;
  cacheRead?: unknown;
}

export interface ReplaceCandidate extends TokenCountsSource {
  isSidechain?: boolean;
  speed?: string | null;
}

export interface UsageTotals {
  tokens: number;
  costUSD: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

interface RawUsageCounts {
  speed?: unknown;
  costUSD?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  iterations?: unknown;
}

interface RawAdvisorIteration {
  type?: unknown;
  usage?: unknown;
  message?: { model?: unknown; usage?: unknown } | null;
}

interface RawUsageLine {
  timestamp?: unknown;
  cwd?: unknown;
  version?: unknown;
  sessionId?: unknown;
  requestId?: unknown;
  isSidechain?: unknown;
  costUSD?: unknown;
  id?: unknown;
  message?: { id?: unknown; model?: unknown; usage?: unknown } | null;
}

function parseJsonLine(line: unknown, requiredSubstring?: string): Record<string, unknown> | null {
  if (typeof line !== 'string') return null;
  if (requiredSubstring && !line.includes(requiredSubstring)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as Record<string, unknown>;
}

function parseUsageLine(
  line: unknown,
  { versionPrefix }: { versionPrefix?: string } = {},
): UsageEntry | null {
  const raw = parseJsonLine(line, '"usage":{');
  if (!raw) return null;
  const parsed = raw as RawUsageLine;
  if (hasExplicitNull(parsed)) return null;
  if (!versionIsAccepted(parsed.version, versionPrefix)) return null;
  if (hasPresentEmptyIdentity(parsed)) return null;

  const message = parsed.message;
  if (!message || typeof message !== 'object') return null;
  if (typeof message.model === 'string' && message.model.trim() === '') return null;
  const rawUsage = message.usage;
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const usage = rawUsage as RawUsageCounts;

  const timestampMs = Date.parse(String(parsed.timestamp));
  if (!Number.isFinite(timestampMs)) return null;

  const rawModel = message.model === '<synthetic>' ? null : stringOrNull(message.model);
  const speed = stringOrNull(usage.speed);

  return {
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    cwd: stringOrNull(parsed.cwd),
    version: stringOrNull(parsed.version),
    sessionId: stringOrNull(parsed.sessionId),
    requestId: stringOrNull(parsed.requestId),
    messageId: stringOrNull(message.id),
    model: modelWithSpeed(rawModel, speed),
    rawModel,
    speed,
    isSidechain: parsed.isSidechain === true,
    costUSD: numberOrNull(parsed.costUSD) ?? numberOrNull(usage.costUSD),
    ...tokenCountsFromUsage(usage),
    iterations: Array.isArray(usage.iterations) ? usage.iterations : [],
  };
}

function expandAdvisorIterations(entry: UsageEntry | null | undefined): UsageEntry[] {
  if (!entry || !Array.isArray(entry.iterations)) return [];
  const advisorEntries: UsageEntry[] = [];
  for (let iterationIndex = 0; iterationIndex < entry.iterations.length; iterationIndex += 1) {
    const iteration = entry.iterations[iterationIndex] as RawAdvisorIteration | null;
    if (!iteration || iteration.type !== 'advisor_message') continue;
    const rawIterationUsage = iteration.usage || iteration.message?.usage || iteration;
    if (!rawIterationUsage || typeof rawIterationUsage !== 'object') continue;
    const usage = rawIterationUsage as RawUsageCounts;
    const rawModel = iteration.message?.model === '<synthetic>'
      ? null
      : stringOrNull(iteration.message?.model) || entry.rawModel || null;
    const speed = stringOrNull(usage.speed) || entry.speed || null;
    advisorEntries.push({
      ...entry,
      messageId: entry.messageId ? `${entry.messageId}:advisor:${iterationIndex}` : null,
      model: modelWithSpeed(rawModel, speed),
      rawModel,
      speed,
      costUSD: null,
      ...tokenCountsFromUsage(usage),
      iterations: [],
      isAdvisor: true,
    });
  }
  return advisorEntries;
}

function identityFromRelPath(relPath: unknown): { project: string | null; sessionId: string | null } {
  const parts = String(relPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const jsonlIndex = parts.findIndex((part) => part.endsWith('.jsonl'));
  const projectPartsEnd = parts[0] === 'projects' ? 2 : 1;
  const project = parts.slice(parts[0] === 'projects' ? 1 : 0, projectPartsEnd).join('/') || null;
  if (jsonlIndex === -1) return { project, sessionId: null };
  const subagentsIndex = parts.indexOf('subagents');
  if (subagentsIndex > 0) return { project, sessionId: parts[subagentsIndex - 1] || null };
  return { project, sessionId: path.basename(parts[jsonlIndex], '.jsonl') || null };
}

function dedupKeys(
  entry: { messageId?: string | null; requestId?: string | null } | null | undefined,
): { primary: string | null; collision: string | null } {
  // Caller contract: a primary hit always dedups; a collision hit dedups only when either entry isSidechain.
  if (!entry || !entry.messageId) return { primary: null, collision: null };
  const primary = entry.requestId ? `${entry.messageId}:${entry.requestId}` : entry.messageId;
  return { primary, collision: entry.messageId };
}

function shouldReplace(
  existing: ReplaceCandidate | null | undefined,
  candidate: ReplaceCandidate | null | undefined,
): boolean {
  if (!existing) return true;
  if (!candidate) return false;
  if (existing.isSidechain && !candidate.isSidechain) return true;
  if (!existing.isSidechain && candidate.isSidechain) return false;
  const existingTokens = totalTokensOf(existing);
  const candidateTokens = totalTokensOf(candidate);
  if (candidateTokens > existingTokens) return true;
  if (candidateTokens < existingTokens) return false;
  return !existing.speed && Boolean(candidate.speed);
}

function totalTokensOf(entry: TokenCountsSource | null | undefined): number {
  if (!entry) return 0;
  return safeNumber(entry.input) + safeNumber(entry.output) + safeNumber(entry.cacheCreate) + safeNumber(entry.cacheRead);
}

function emptyTotals(): UsageTotals {
  return { tokens: 0, costUSD: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

function addEntryToTotals(totals: UsageTotals, entry: TokenCountsSource, tokens: number = totalTokensOf(entry)): void {
  totals.input += safeNumber(entry.input);
  totals.output += safeNumber(entry.output);
  totals.cacheCreate += safeNumber(entry.cacheCreate);
  totals.cacheRead += safeNumber(entry.cacheRead);
  totals.tokens += tokens;
  totals.costUSD += safeNumber(entry.costUSD);
}

function vendorUsageEntry({
  timestampMs, sessionId, model, input, output, cacheCreate, cacheRead, costUSD, vendor, messageId = null,
}: {
  timestampMs: number;
  sessionId: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  costUSD: number | null;
  vendor: string;
  messageId?: string | null;
}): UsageEntry {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    sessionId,
    model,
    input,
    output,
    cacheCreate,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    cacheRead,
    costUSD,
    vendor,
    messageId,
    requestId: null,
    isSidechain: false,
  };
}

function modelWithSpeed(rawModel: string | null, speed: string | null): string | null {
  if (!rawModel || speed !== 'fast' || rawModel.endsWith('-fast')) return rawModel;
  return `${rawModel}-fast`;
}

function tokenCountsFromUsage(usage: RawUsageCounts): {
  input: number;
  output: number;
  cacheCreate: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  cacheRead: number;
} {
  const input = safeNumber(usage.input_tokens);
  const output = safeNumber(usage.output_tokens);
  const cacheCreation = usage.cache_creation && typeof usage.cache_creation === 'object'
    ? (usage.cache_creation as { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown })
    : null;
  const cacheCreation5m = cacheCreation
    ? safeNumber(cacheCreation.ephemeral_5m_input_tokens)
    : safeNumber(usage.cache_creation_input_tokens);
  const cacheCreation1h = cacheCreation ? safeNumber(cacheCreation.ephemeral_1h_input_tokens) : 0;
  const cacheCreate = cacheCreation5m + cacheCreation1h;
  const cacheRead = safeNumber(usage.cache_read_input_tokens);
  return { input, output, cacheCreate, cacheCreation5m, cacheCreation1h, cacheRead };
}

function hasExplicitNull(parsed: unknown): boolean {
  return NULL_REJECT_FIELDS.some((fieldPath) => hasNullAtPath(parsed, fieldPath));
}

function hasNullAtPath(value: unknown, fieldPath: readonly string[]): boolean {
  let current: unknown = value;
  for (const part of fieldPath) {
    if (!current || typeof current !== 'object') return false;
    if (!Object.hasOwn(current, part)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return current === null;
}

function versionIsAccepted(version: unknown, versionPrefix: string | undefined): boolean {
  if (typeof version !== 'string' || version.length === 0) return true;
  if (!/^\d+\.\d+\.\d+/.test(version)) return false;
  if (!versionPrefix) return true;
  return version.startsWith(versionPrefix);
}

function hasPresentEmptyIdentity(parsed: RawUsageLine): boolean {
  if (presentEmpty(parsed.sessionId)) return true;
  if (presentEmpty(parsed.requestId)) return true;
  if (presentEmpty(parsed.id)) return true;
  if (presentEmpty(parsed.message?.id)) return true;
  return presentEmpty(parsed.message?.model);
}

function presentEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '';
}

export { addEntryToTotals, dedupKeys, emptyTotals, expandAdvisorIterations, identityFromRelPath, parseJsonLine, parseUsageLine, shouldReplace, totalTokensOf, vendorUsageEntry };
