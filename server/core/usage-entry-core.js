'use strict';

const path = require('node:path');
const { numberOrNull, safeNumber, stringOrNull } = require('./usage-number-core');

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

function parseJsonLine(line, requiredSubstring) {
  if (typeof line !== 'string') return null;
  if (requiredSubstring && !line.includes(requiredSubstring)) return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

function parseUsageLine(line, { versionPrefix } = {}) {
  const parsed = parseJsonLine(line, '"usage":{');
  if (!parsed) return null;
  if (hasExplicitNull(parsed)) return null;
  if (!versionIsAccepted(parsed.version, versionPrefix)) return null;
  if (hasPresentEmptyIdentity(parsed)) return null;

  const message = parsed.message;
  if (!message || typeof message !== 'object') return null;
  if (typeof message.model === 'string' && message.model.trim() === '') return null;
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') return null;

  const timestampMs = Date.parse(parsed.timestamp);
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

function expandAdvisorIterations(entry) {
  if (!entry || !Array.isArray(entry.iterations)) return [];
  const advisorEntries = [];
  for (let iterationIndex = 0; iterationIndex < entry.iterations.length; iterationIndex += 1) {
    const iteration = entry.iterations[iterationIndex];
    if (!iteration || iteration.type !== 'advisor_message') continue;
    const usage = iteration.usage || iteration.message?.usage || iteration;
    if (!usage || typeof usage !== 'object') continue;
    const rawModel = iteration.message?.model === '<synthetic>'
      ? null
      : stringOrNull(iteration.message?.model) || entry.rawModel;
    const speed = stringOrNull(usage.speed) || entry.speed;
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

function identityFromRelPath(relPath) {
  const parts = String(relPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const jsonlIndex = parts.findIndex((part) => part.endsWith('.jsonl'));
  const projectPartsEnd = parts[0] === 'projects' ? 2 : 1;
  const project = parts.slice(parts[0] === 'projects' ? 1 : 0, projectPartsEnd).join('/') || null;
  if (jsonlIndex === -1) return { project, sessionId: null };
  const subagentsIndex = parts.indexOf('subagents');
  if (subagentsIndex > 0) return { project, sessionId: parts[subagentsIndex - 1] || null };
  return { project, sessionId: path.basename(parts[jsonlIndex], '.jsonl') || null };
}

function dedupKeys(entry) {
  // Caller contract: a primary hit always dedups; a collision hit dedups only when either entry isSidechain.
  if (!entry || !entry.messageId) return { primary: null, collision: null };
  const primary = entry.requestId ? `${entry.messageId}:${entry.requestId}` : entry.messageId;
  return { primary, collision: entry.messageId };
}

function shouldReplace(existing, candidate) {
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

function totalTokensOf(entry) {
  if (!entry) return 0;
  return safeNumber(entry.input) + safeNumber(entry.output) + safeNumber(entry.cacheCreate) + safeNumber(entry.cacheRead);
}

function emptyTotals() {
  return { tokens: 0, costUSD: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

function addEntryToTotals(totals, entry, tokens = totalTokensOf(entry)) {
  totals.input += safeNumber(entry.input);
  totals.output += safeNumber(entry.output);
  totals.cacheCreate += safeNumber(entry.cacheCreate);
  totals.cacheRead += safeNumber(entry.cacheRead);
  totals.tokens += tokens;
  totals.costUSD += safeNumber(entry.costUSD);
}

function vendorUsageEntry({
  timestampMs, sessionId, model, input, output, cacheCreate, cacheRead, costUSD, vendor, messageId = null,
}) {
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

function modelWithSpeed(rawModel, speed) {
  if (!rawModel || speed !== 'fast' || rawModel.endsWith('-fast')) return rawModel;
  return `${rawModel}-fast`;
}

function tokenCountsFromUsage(usage) {
  const input = safeNumber(usage.input_tokens);
  const output = safeNumber(usage.output_tokens);
  const cacheCreation = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  const cacheCreation5m = cacheCreation
    ? safeNumber(cacheCreation.ephemeral_5m_input_tokens)
    : safeNumber(usage.cache_creation_input_tokens);
  const cacheCreation1h = cacheCreation ? safeNumber(cacheCreation.ephemeral_1h_input_tokens) : 0;
  const cacheCreate = cacheCreation5m + cacheCreation1h;
  const cacheRead = safeNumber(usage.cache_read_input_tokens);
  return { input, output, cacheCreate, cacheCreation5m, cacheCreation1h, cacheRead };
}

function hasExplicitNull(parsed) {
  return NULL_REJECT_FIELDS.some((fieldPath) => hasNullAtPath(parsed, fieldPath));
}

function hasNullAtPath(value, fieldPath) {
  let current = value;
  for (const part of fieldPath) {
    if (!current || typeof current !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = current[part];
  }
  return current === null;
}

function versionIsAccepted(version, versionPrefix) {
  if (typeof version !== 'string' || version.length === 0) return true;
  if (!/^\d+\.\d+\.\d+/.test(version)) return false;
  if (!versionPrefix) return true;
  return version.startsWith(versionPrefix);
}

function hasPresentEmptyIdentity(parsed) {
  if (presentEmpty(parsed.sessionId)) return true;
  if (presentEmpty(parsed.requestId)) return true;
  if (presentEmpty(parsed.id)) return true;
  if (presentEmpty(parsed.message?.id)) return true;
  return presentEmpty(parsed.message?.model);
}

function presentEmpty(value) {
  return typeof value === 'string' && value.trim() === '';
}

module.exports = {
  addEntryToTotals,
  dedupKeys,
  emptyTotals,
  expandAdvisorIterations,
  identityFromRelPath,
  parseJsonLine,
  parseUsageLine,
  shouldReplace,
  totalTokensOf,
  vendorUsageEntry,
};
