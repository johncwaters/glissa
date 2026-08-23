'use strict';

// Pure assembly of the Mill tab's report: one row per context-pack spec, joining what the spec asks
// for, what the last build produced, which live sessions were spawned against it, and which config
// keys name it. No IO and no clock; the shell (server/mill-wiring.js) reads the specs, the manifests
// and the session snapshots, and passes `ts` in the way the other cores take time.
//
// Everything here is derived on demand. The mill keeps no durable state of its own, so a report is
// only ever as true as the moment it was built, and nothing in it is worth persisting.

const { MAX_INDEX_TOKENS, normalizePackNames, validatePackSpec } = require('./pack-core');
const { isPlainObject, numberOrNull, safeNumber, stringOrNull } = require('./usage-number-core');

// A pack delivering more files than this is a spec problem, not something a scrolling list fixes, so
// the tail is counted rather than rendered.
const MAX_OUTPUT_ROWS = 50;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function countOf(value) {
  return asArray(value).length;
}

/** Percentage of a pack's budget its last build spent, or null when either side is unknown. */
function budgetPercent(tokenEstimate, budgetTokens) {
  const spent = numberOrNull(tokenEstimate);
  const budget = numberOrNull(budgetTokens);
  if (spent === null || budget === null || budget <= 0) return null;
  return (spent / budget) * 100;
}

function builtFrom(manifest) {
  if (!isPlainObject(manifest)) return null;
  const outputs = asArray(manifest.outputs).map((output) => ({
    relPath: String(output?.relPath ?? ''),
    tokenEstimate: numberOrNull(output?.tokenEstimate),
  }));
  const fileCount = asArray(manifest.sources).reduce((total, source) => total + countOf(source?.files), 0);
  return {
    version: stringOrNull(manifest.version),
    builtAt: stringOrNull(manifest.builtAt),
    // A measured size, so absent stays absent: rendering a manifest that never recorded one as zero
    // tokens would read as an empty pack rather than an unmeasured one. Counts below keep safeNumber.
    tokenEstimate: numberOrNull(manifest.tokenEstimate),
    budgetTokens: numberOrNull(manifest.budgetTokens),
    budgetPct: budgetPercent(manifest.tokenEstimate, manifest.budgetTokens),
    indexTokenEstimate: numberOrNull(manifest.indexTokenEstimate),
    indexTokenCap: MAX_INDEX_TOKENS,
    fileCount,
    skillCount: countOf(manifest.skills),
    ruleCount: countOf(manifest.rules),
    outputs: outputs.slice(0, MAX_OUTPUT_ROWS),
    moreOutputs: Math.max(outputs.length - MAX_OUTPUT_ROWS, 0),
  };
}

/**
 * Which live sessions are running this pack, and whether each is running the current build. A
 * delivery is judged stale only when BOTH versions are known: a pack with no readable manifest is an
 * unknown, and calling that stale would put a warning on the one case nothing can be said about.
 */
function deliveriesFor(name, sessionRows, builtVersion) {
  const deliveries = [];
  for (const row of asArray(sessionRows)) {
    for (const delivered of asArray(row?.packs)) {
      if (delivered?.name !== name) continue;
      const version = stringOrNull(delivered.version);
      deliveries.push({
        sessionId: stringOrNull(row.sessionId),
        sessionName: stringOrNull(row.sessionName),
        state: stringOrNull(row.state),
        version,
        reads: safeNumber(delivered.reads),
        readsSinceNotice: numberOrNull(delivered.readsSinceNotice),
        stale: version !== null && builtVersion !== null ? version !== builtVersion : null,
      });
    }
  }
  return deliveries;
}

// null is the honest third answer for a drift check: it could not run, which is neither current nor stale.
function tristate(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function distillRowsFrom(entries) {
  return asArray(entries).map((entry) => ({
    output: String(entry?.output ?? ''),
    stale: tristate(entry?.stale),
    reason: stringOrNull(entry?.reason),
  }));
}

/**
 * Every config key naming packs, normalized through the SAME rule a spawn applies, so the tab reports
 * the list that would actually be delivered rather than the one written down.
 */
function resolveConsumers(consumers) {
  const projectsByPack = new Map();
  const warnings = [];
  const collect = (label, raw) => {
    const { names, warnings: found } = normalizePackNames(raw);
    for (const warning of found) warnings.push(`${label}: ${warning}`);
    return names;
  };

  for (const project of asArray(consumers?.projects)) {
    const label = stringOrNull(project?.name) || 'project';
    for (const name of collect(`project "${label}"`, project?.packs)) {
      if (!projectsByPack.has(name)) projectsByPack.set(name, []);
      projectsByPack.get(name).push(label);
    }
  }
  const prReview = collect('prReview.packs', consumers?.prReview);
  const posthog = collect('posthog.packs', consumers?.posthog);
  return { projectsByPack, prReview, posthog, warnings };
}

/** Packs a consumer names that no spec defines: a delivery that will silently be skipped at spawn. */
function unknownConsumerWarnings(consumers, knownNames) {
  const warnings = [];
  for (const [name, projects] of consumers.projectsByPack) {
    if (knownNames.has(name)) continue;
    warnings.push(`project "${projects[0]}" names pack "${name}", which has no spec`);
  }
  for (const name of consumers.prReview) {
    if (knownNames.has(name)) continue;
    warnings.push(`prReview.packs names pack "${name}", which has no spec`);
  }
  for (const name of consumers.posthog) {
    if (knownNames.has(name)) continue;
    warnings.push(`posthog.packs names pack "${name}", which has no spec`);
  }
  return warnings;
}

/**
 * The skip reason a client may see, with the server's filesystem taken out of it. resolveBuiltPack
 * builds its reasons around absolute paths, and a paired phone is a remote client on the far side of
 * this report, so the tab gets the verdict rather than the operator's directory layout.
 */
function shortBuiltReason(reason) {
  const text = stringOrNull(reason);
  if (text === null) return null;
  if (text.startsWith('not a valid pack name')) return 'not a valid pack name';
  if (text.startsWith('not built')) return 'not built';
  return 'manifest missing or unreadable';
}

/**
 * Every reason this spec would not build. Beyond the validator, the BUILDER also refuses a spec whose
 * `name` differs from its filename (pack-builder.js), and a tab reporting that pack as valid but
 * permanently unbuilt names no cause the operator can act on.
 */
function specErrorsFor(entry) {
  if (entry.specError) return { valid: false, errors: [String(entry.specError)] };
  if (!isPlainObject(entry.spec)) return { valid: false, errors: ['spec file could not be read'] };
  const check = validatePackSpec(entry.spec);
  const errors = asArray(check.errors).map(String);
  const fileName = stringOrNull(entry.name);
  const declared = stringOrNull(entry.spec.name);
  if (fileName !== null && declared !== null && declared !== fileName) {
    errors.push(`spec name "${declared}" does not match its filename`);
  }
  return { valid: errors.length === 0, errors };
}

function buildPackRow(entry, { consumers, sessionRows }) {
  const name = String(entry?.name ?? '');
  const spec = isPlainObject(entry?.spec) ? entry.spec : null;
  const manifest = isPlainObject(entry?.manifest) ? entry.manifest : null;
  const { valid, errors } = specErrorsFor(entry || {});
  const built = builtFrom(manifest);
  const deliveredTo = deliveriesFor(name, sessionRows, built ? built.version : null);
  return {
    name,
    description: stringOrNull(spec?.description) || stringOrNull(manifest?.description) || '',
    specValid: valid,
    specErrors: errors,
    sourceCount: countOf(spec?.sources),
    budgetTokens: numberOrNull(spec?.budgetTokens),
    built,
    builtReason: built ? null : shortBuiltReason(entry?.builtReason),
    deliveredTo,
    totalReads: deliveredTo.reduce((total, delivery) => total + delivery.reads, 0),
    staleDeliveries: deliveredTo.filter((delivery) => delivery.stale === true).length,
    consumers: {
      projects: consumers.projectsByPack.get(name) || [],
      prReview: consumers.prReview.includes(name),
      posthog: consumers.posthog.includes(name),
    },
    distill: distillRowsFrom(entry?.distill),
  };
}

function totalsFrom(packs) {
  return {
    packCount: packs.length,
    builtCount: packs.filter((pack) => pack.built !== null).length,
    invalidSpecs: packs.filter((pack) => !pack.specValid).length,
    staleDeliveries: packs.reduce((total, pack) => total + pack.staleDeliveries, 0),
    staleDistills: packs.reduce((total, pack) => total + pack.distill.filter((row) => row.stale === true).length, 0),
    totalReads: packs.reduce((total, pack) => total + pack.totalReads, 0),
  };
}

/**
 * The whole Mill report. `specs` carries one entry per spec file, already read by the shell; every
 * decision about what those bytes MEAN is made here.
 */
function buildMillReport(input) {
  const consumers = resolveConsumers(input?.consumers);
  const specs = asArray(input?.specs);
  const sessionRows = asArray(input?.sessionRows);
  const packs = specs.map((entry) => buildPackRow(entry, { consumers, sessionRows }));
  const knownNames = new Set(packs.map((pack) => pack.name));
  return {
    type: 'mill-report',
    requestId: stringOrNull(input?.requestId),
    ts: safeNumber(input?.ts),
    autoRebuild: input?.autoRebuild === true,
    distillerEnabled: input?.distillerEnabled === true,
    watcherCount: numberOrNull(input?.watcherCount),
    packs,
    configWarnings: [...consumers.warnings, ...unknownConsumerWarnings(consumers, knownNames)],
    totals: totalsFrom(packs),
    error: null,
  };
}

module.exports = {
  MAX_OUTPUT_ROWS,
  budgetPercent,
  buildMillReport,
  deliveriesFor,
  resolveConsumers,
  shortBuiltReason,
};
