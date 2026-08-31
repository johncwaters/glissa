'use strict';

// Pure assembly of the Mill tab's report: one row per context-pack spec, joining what the spec asks
// for, what the last build produced, which live sessions were spawned against it, and which config
// keys name it. No IO and no clock; the shell (server/mill-wiring.js) reads the specs, the manifests
// and the session snapshots, and passes `ts` in the way the other cores take time.
//
// Everything except measurement is derived on demand. The shell injects that durable state, while the
// rest of the report is only ever as true as the moment it was built.

const { DELIVERY_SKIP_EMPTY, MAX_INDEX_TOKENS, MAX_PACKS_PER_SESSION, decidePackDelivery, normalizePackNames, validatePackSpec } = require('./pack-core');
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
    // Never delivered, so the tab reads it as empty rather than as an unnamed pack nobody consumes.
    empty: decidePackDelivery({ manifest }).reason === DELIVERY_SKIP_EMPTY,
    outputs: outputs.slice(0, MAX_OUTPUT_ROWS),
    moreOutputs: Math.max(outputs.length - MAX_OUTPUT_ROWS, 0),
  };
}

function worstStale(current, next) {
  if (current === true || next === true) return true;
  if (current === null || next === null) return null;
  return false;
}

// Stale needs BOTH versions known: an unreadable manifest is unknown, and unknown must not warn.
function deliveriesFor(name, sessionRows, builtVersion, labelByPath = new Map(), consumerTargets = []) {
  const deliveries = [];
  const deliveryByKey = new Map();
  for (const [index, row] of asArray(sessionRows).entries()) {
    const projectPath = stringOrNull(row?.path);
    const key = projectPath === null ? `session:${index}` : `path:${projectPath}`;
    for (const delivered of asArray(row?.packs)) {
      if (delivered?.name !== name) continue;
      const version = stringOrNull(delivered.version);
      const state = stringOrNull(row.state);
      const stale = version !== null && builtVersion !== null ? version !== builtVersion : null;
      const existing = deliveryByKey.get(key);
      if (existing) {
        existing.sessionCount += 1;
        existing.state = existing.state === state ? state : null;
        existing.version = existing.version === version ? version : null;
        existing.stale = worstStale(existing.stale, stale);
        existing.staleSessions += stale === true ? 1 : 0;
        continue;
      }
      const projectLabel = projectPath === null ? null : stringOrNull(labelByPath.get(projectPath));
      const delivery = {
        project: projectLabel || stringOrNull(row.sessionName) || 'session',
        sessionCount: 1,
        state,
        version,
        stale,
        staleSessions: stale === true ? 1 : 0,
        pending: false,
      };
      deliveryByKey.set(key, delivery);
      deliveries.push(delivery);
    }
  }
  for (const target of asArray(consumerTargets)) {
    const targetPath = stringOrNull(target?.path);
    if (targetPath === null || deliveryByKey.has(`path:${targetPath}`)) continue;
    const cards = asArray(sessionRows).filter((row) => row?.ephemeral !== true && stringOrNull(row?.path) === targetPath);
    const cardStates = new Set(cards.map((card) => stringOrNull(card.state)));
    const delivery = {
      project: stringOrNull(target?.label) || 'project',
      sessionCount: cards.length,
      state: cardStates.size === 1 ? [...cardStates][0] : null,
      version: null,
      stale: null,
      staleSessions: 0,
      pending: true,
    };
    deliveryByKey.set(`path:${targetPath}`, delivery);
    deliveries.push(delivery);
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
 * the list that would actually be delivered rather than the one written down. A project row is one
 * PROJECT (pack-core's `packConsumerGroups`), never one card, which is what the assignment control and
 * the delivery rows are both addressed by.
 */
function resolveConsumers(sources) {
  const projectsByPack = new Map();
  const targetsByPack = new Map();
  const labelByPath = new Map();
  const pathById = new Map();
  const projects = [];
  const lanes = [];
  const warnings = [];

  for (const source of asArray(sources)) {
    const label = stringOrNull(source?.label) || 'project';
    const { names, warnings: found } = normalizePackNames(source?.packs);
    for (const warning of found) {
      warnings.push(`${source?.kind === 'project' ? `project "${label}"` : label}: ${warning}`);
    }
    if (source?.kind !== 'project') {
      lanes.push({ kind: String(source?.kind ?? ''), label, names });
      continue;
    }
    // The id is what the Mill tab's assignment control addresses, and the normalized names are what a
    // spawn would actually deliver, so a checkbox reflects delivery rather than what was written down.
    projects.push({ id: stringOrNull(source?.id), name: label, packs: names });
    const projectPath = stringOrNull(source?.path);
    if (projectPath !== null && !labelByPath.has(projectPath)) labelByPath.set(projectPath, label);
    if (projectPath !== null) {
      for (const recordId of [stringOrNull(source?.id), ...asArray(source?.recordIds)]) {
        if (typeof recordId === 'string' && recordId) pathById.set(recordId, projectPath);
      }
    }
    for (const name of names) {
      if (!projectsByPack.has(name)) projectsByPack.set(name, []);
      projectsByPack.get(name).push(label);
      if (projectPath === null) continue;
      if (!targetsByPack.has(name)) targetsByPack.set(name, []);
      targetsByPack.get(name).push({ path: projectPath, label });
    }
  }
  return { projectsByPack, targetsByPack, labelByPath, pathById, projects, lanes, warnings };
}

/** Packs a consumer names that no spec defines: a delivery that will silently be skipped at spawn. */
function unknownConsumerWarnings(consumers, knownNames) {
  const warnings = [];
  for (const [name, projects] of consumers.projectsByPack) {
    if (knownNames.has(name)) continue;
    warnings.push(`project "${projects[0]}" names pack "${name}", which has no spec`);
  }
  for (const lane of consumers.lanes) {
    for (const name of lane.names) {
      if (knownNames.has(name)) continue;
      warnings.push(`${lane.label} names pack "${name}", which has no spec`);
    }
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
  // A derived variant is named after its group plus a project, never after a spec file of its own.
  const fileName = stringOrNull(entry.group) === null ? stringOrNull(entry.name) : stringOrNull(entry.spec.name);
  const declared = stringOrNull(entry.spec.name);
  if (fileName !== null && declared !== null && declared !== fileName) {
    errors.push(`spec name "${declared}" does not match its filename`);
  }
  return { valid: errors.length === 0, errors };
}

function builtVariantPathsByGroup(specs, consumers) {
  const pathsByGroup = new Map();
  for (const entry of specs) {
    const group = stringOrNull(entry?.group);
    if (group === null || !isPlainObject(entry?.manifest)) continue;
    const path = consumers.pathById.get(stringOrNull(entry?.variantProject?.id));
    if (!path) continue;
    const paths = pathsByGroup.get(group) || new Set();
    paths.add(path);
    pathsByGroup.set(group, paths);
  }
  return pathsByGroup;
}

function deliveryTargetsFor(name, entry, consumers, builtVariantPaths) {
  const group = stringOrNull(entry?.group);
  if (group !== null) {
    const variantProject = entry?.variantProject || null;
    const path = consumers.pathById.get(stringOrNull(variantProject?.id));
    if (!path) return [];
    return [{ path, label: stringOrNull(variantProject?.label) || 'project' }];
  }
  const targets = consumers.targetsByPack.get(name) || [];
  if (!isPlainObject(entry?.spec) || entry.spec.perProjectVariants !== true) return targets;
  // A consumer covered by a BUILT variant pends on that variant's row; every other one falls back to
  // this base pack at spawn (resolveVariant in session/session-pack-delivery.js), so it pends here.
  const covered = builtVariantPaths.get(name);
  if (!covered) return targets;
  return targets.filter((target) => !covered.has(target.path));
}

// The SAME verdict the spawn reaches, so a pending row never promises a delivery the gate would refuse.
function pendingTargetsFor(name, entry, consumers, { specValid, built, manifest, packsDir, builtVariantPaths }) {
  if (!specValid || built === null || built.empty === true) return [];
  return deliveryTargetsFor(name, entry, consumers, builtVariantPaths)
    .filter((target) => decidePackDelivery({ manifest, projectPath: target.path, packsDir }).deliver);
}

function buildPackRow(entry, { consumers, sessionRows, measurementByPack, packsDir, builtVariantPaths }) {
  const name = String(entry?.name ?? '');
  const spec = isPlainObject(entry?.spec) ? entry.spec : null;
  const manifest = isPlainObject(entry?.manifest) ? entry.manifest : null;
  const { valid, errors } = specErrorsFor(entry || {});
  const built = builtFrom(manifest);
  const pendingTargets = pendingTargetsFor(name, entry, consumers, { specValid: valid, built, manifest, packsDir, builtVariantPaths });
  const deliveredTo = deliveriesFor(name, sessionRows, built ? built.version : null, consumers.labelByPath, pendingTargets);
  const group = stringOrNull(entry?.group);
  // A variant's consumer is exactly the project it was derived for; nothing else may ever be handed it.
  const variantProject = group === null ? null : (entry?.variantProject || null);
  const namedBy = {
    projects: group === null
      ? (consumers.projectsByPack.get(name) || [])
      : [stringOrNull(variantProject?.label) || 'project'],
    // Which LANES name it, carried as the kinds pack-core enumerated rather than a fixed pair of
    // booleans, so adding a pack-naming config key there reaches this row with no change here.
    lanes: group === null
      ? consumers.lanes.filter((lane) => lane.names.includes(name)).map((lane) => ({ kind: lane.kind, label: lane.label }))
      : [],
  };
  return {
    name,
    // The group this row was derived from, or null for an ordinary pack. A group's own row keeps
    // `group` null: it is the base build and the fallback, not a variant of itself.
    group,
    projectId: stringOrNull(variantProject?.id),
    description: stringOrNull(spec?.description) || stringOrNull(manifest?.description) || '',
    specValid: valid,
    specErrors: errors,
    sourceCount: countOf(spec?.sources),
    budgetTokens: numberOrNull(spec?.budgetTokens),
    built,
    builtReason: built ? null : shortBuiltReason(entry?.builtReason),
    deliveredTo,
    staleDeliveries: deliveredTo.reduce((total, delivery) => total + delivery.staleSessions, 0),
    consumers: namedBy,
    // Nothing names it, so the mill deliberately neither builds nor watches it: an informational state,
    // never an unbuilt-pack warning.
    hasConsumers: namedBy.projects.length > 0 || namedBy.lanes.length > 0,
    distill: distillRowsFrom(entry?.distill),
    measurement: measurementByPack?.[name] ?? null,
  };
}

function totalsFrom(packs) {
  return {
    packCount: packs.length,
    variantCount: packs.filter((pack) => pack.group !== null).length,
    builtCount: packs.filter((pack) => pack.built !== null).length,
    unconsumed: packs.filter((pack) => !pack.hasConsumers).length,
    emptyBuilds: packs.filter((pack) => pack.built?.empty === true).length,
    invalidSpecs: packs.filter((pack) => !pack.specValid).length,
    staleDeliveries: packs.reduce((total, pack) => total + pack.staleDeliveries, 0),
    staleDistills: packs.reduce((total, pack) => total + pack.distill.filter((row) => row.stale === true).length, 0),
  };
}

/**
 * The whole Mill report. `specs` carries one entry per spec file, already read by the shell; every
 * decision about what those bytes MEAN is made here.
 */
function buildMillReport(input) {
  const consumers = resolveConsumers(input?.consumerSources);
  const specs = asArray(input?.specs);
  const sessionRows = asArray(input?.sessionRows);
  const measurementByPack = isPlainObject(input?.measurementByPack) ? input.measurementByPack : {};
  const packsDir = stringOrNull(input?.packsDir);
  const builtVariantPaths = builtVariantPathsByGroup(specs, consumers);
  const packs = specs.map((entry) => buildPackRow(entry, { consumers, sessionRows, measurementByPack, packsDir, builtVariantPaths }));
  // A group name is what a project assigns, so a variant name never counts as a known consumer target.
  const knownNames = new Set(packs.filter((pack) => pack.group === null).map((pack) => pack.name));
  return {
    type: 'mill-report',
    requestId: stringOrNull(input?.requestId),
    ts: safeNumber(input?.ts),
    autoRebuild: input?.autoRebuild === true,
    distillerEnabled: input?.distillerEnabled === true,
    watcherCount: numberOrNull(input?.watcherCount),
    // The assignment control's targets, and the cap it must refuse a fifth pack at. Shipped rather than
    // restated in the browser, so the tab and the spawn cannot disagree about the ceiling.
    projects: consumers.projects,
    maxPacksPerProject: MAX_PACKS_PER_SESSION,
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
