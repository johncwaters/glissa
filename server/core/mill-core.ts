import { DELIVERY_SKIP_EMPTY, MAX_INDEX_TOKENS, MAX_PACKS_PER_SESSION, decidePackDelivery, normalizePackNames, validatePackSpec } from './pack-core.ts';
import { isPlainObject, numberOrNull, safeNumber, stringOrNull } from './usage-number-core.ts';

const MAX_OUTPUT_ROWS = 50;

type LooseRecord = Record<string, unknown>;

export interface MillDelivery {
  project: string;
  sessionCount: number;
  state: string | null;
  version: string | null;
  stale: boolean | null;
  staleSessions: number;
  pending: boolean;
}

export interface MillDeliveryTarget {
  path: string;
  label: string;
}

export interface MillBuild {
  version: string | null;
  builtAt: string | null;
  tokenEstimate: number | null;
  budgetTokens: number | null;
  budgetPct: number | null;
  indexTokenEstimate: number | null;
  indexTokenCap: number;
  fileCount: number;
  skillCount: number;
  ruleCount: number;
  empty: boolean;
  outputs: { relPath: string; tokenEstimate: number | null }[];
  moreOutputs: number;
}

export interface MillLane {
  kind: string;
  label: string;
  names: string[];
}

export interface MillConsumers {
  projectsByPack: Map<string, string[]>;
  targetsByPack: Map<string, MillDeliveryTarget[]>;
  labelByPath: Map<string, string>;
  pathById: Map<string, string>;
  projects: { id: string | null; name: string; packs: string[] }[];
  lanes: MillLane[];
  warnings: string[];
}

export interface MillReport {
  type: string;
  requestId: string | null;
  ts: number;
  autoRebuild: boolean;
  distillerEnabled: boolean;
  watcherCount: number | null;
  projects: { id: string | null; name: string; packs: string[] }[];
  maxPacksPerProject: number;
  packs: MillPackRow[];
  configWarnings: string[];
  totals: Record<string, number>;
  error: null;
}

export interface MillPackRow {
  name: string;
  group: string | null;
  projectId: string | null;
  description: string;
  specValid: boolean;
  specErrors: string[];
  sourceCount: number;
  budgetTokens: number | null;
  built: MillBuild | null;
  builtReason: string | null;
  deliveredTo: MillDelivery[];
  staleDeliveries: number;
  consumers: { projects: string[]; lanes: { kind: string; label: string }[] };
  hasConsumers: boolean;
  distill: { output: string; stale: boolean | null; reason: string | null }[];
  measurement: unknown;
}

function asArray(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value : [];
}

function countOf(value: unknown): number {
  return asArray(value).length;
}

function budgetPercent(tokenEstimate: unknown, budgetTokens: unknown): number | null {
  const spent = numberOrNull(tokenEstimate);
  const budget = numberOrNull(budgetTokens);
  if (spent === null || budget === null || budget <= 0) return null;
  return (spent / budget) * 100;
}

function builtFrom(manifest: unknown): MillBuild | null {
  if (!isPlainObject(manifest)) return null;
  const fields = manifest as LooseRecord;
  const outputs = asArray(fields.outputs).map((output) => ({
    relPath: String(output?.relPath ?? ''),
    tokenEstimate: numberOrNull(output?.tokenEstimate),
  }));
  const fileCount = asArray(fields.sources).reduce((total, source) => total + countOf(source?.files), 0);
  return {
    version: stringOrNull(fields.version),
    builtAt: stringOrNull(fields.builtAt),

    tokenEstimate: numberOrNull(fields.tokenEstimate),
    budgetTokens: numberOrNull(fields.budgetTokens),
    budgetPct: budgetPercent(fields.tokenEstimate, fields.budgetTokens),
    indexTokenEstimate: numberOrNull(fields.indexTokenEstimate),
    indexTokenCap: MAX_INDEX_TOKENS,
    fileCount,
    skillCount: countOf(fields.skills),
    ruleCount: countOf(fields.rules),

    empty: decidePackDelivery({ manifest }).reason === DELIVERY_SKIP_EMPTY,
    outputs: outputs.slice(0, MAX_OUTPUT_ROWS),
    moreOutputs: Math.max(outputs.length - MAX_OUTPUT_ROWS, 0),
  };
}

function worstStale(current: boolean | null, next: boolean | null): boolean | null {
  if (current === true || next === true) return true;
  if (current === null || next === null) return null;
  return false;
}

function deliveriesFor(
  name: string,
  sessionRows: unknown,
  builtVersion: string | null,
  labelByPath: Map<string, string> = new Map(),
  consumerTargets: MillDeliveryTarget[] = [],
): MillDelivery[] {
  const deliveries: MillDelivery[] = [];
  const deliveryByKey = new Map<string, MillDelivery>();
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
      const delivery: MillDelivery = {
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
    const delivery: MillDelivery = {
      project: stringOrNull(target?.label) || 'project',
      sessionCount: cards.length,
      state: cardStates.size === 1 ? ([...cardStates][0] ?? null) : null,
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

function tristate(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function distillRowsFrom(entries: unknown): { output: string; stale: boolean | null; reason: string | null }[] {
  return asArray(entries).map((entry) => ({
    output: String(entry?.output ?? ''),
    stale: tristate(entry?.stale),
    reason: stringOrNull(entry?.reason),
  }));
}

function resolveConsumers(sources: unknown): MillConsumers {
  const projectsByPack = new Map<string, string[]>();
  const targetsByPack = new Map<string, MillDeliveryTarget[]>();
  const labelByPath = new Map<string, string>();
  const pathById = new Map<string, string>();
  const projects: { id: string | null; name: string; packs: string[] }[] = [];
  const lanes: MillLane[] = [];
  const warnings: string[] = [];

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
      projectsByPack.get(name)?.push(label);
      if (projectPath === null) continue;
      if (!targetsByPack.has(name)) targetsByPack.set(name, []);
      targetsByPack.get(name)?.push({ path: projectPath, label });
    }
  }
  return { projectsByPack, targetsByPack, labelByPath, pathById, projects, lanes, warnings };
}

function unknownConsumerWarnings(consumers: MillConsumers, knownNames: Set<string>): string[] {
  const warnings: string[] = [];
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

function shortBuiltReason(reason: unknown): string | null {
  const text = stringOrNull(reason);
  if (text === null) return null;
  if (text.startsWith('not a valid pack name')) return 'not a valid pack name';
  if (text.startsWith('not built')) return 'not built';
  return 'manifest missing or unreadable';
}

function specErrorsFor(entry: LooseRecord): { valid: boolean; errors: string[] } {
  if (entry.specError) return { valid: false, errors: [String(entry.specError)] };
  if (!isPlainObject(entry.spec)) return { valid: false, errors: ['spec file could not be read'] };
  const spec = entry.spec as LooseRecord;
  const check = validatePackSpec(spec);
  const errors = asArray(check.errors).map(String);

  const fileName = stringOrNull(entry.group) === null ? stringOrNull(entry.name) : stringOrNull(spec.name);
  const declared = stringOrNull(spec.name);
  if (fileName !== null && declared !== null && declared !== fileName) {
    errors.push(`spec name "${declared}" does not match its filename`);
  }
  return { valid: errors.length === 0, errors };
}

function variantProjectPath(entry: LooseRecord | null | undefined, consumers: MillConsumers): string | undefined {
  const variantProject = isPlainObject(entry?.variantProject) ? (entry?.variantProject as LooseRecord) : null;
  const variantId = stringOrNull(variantProject?.id);
  if (variantId === null) return undefined;
  return consumers.pathById.get(variantId);
}

function builtVariantPathsByGroup(specs: LooseRecord[], consumers: MillConsumers): Map<string, Set<string>> {
  const pathsByGroup = new Map<string, Set<string>>();
  for (const entry of specs) {
    const group = stringOrNull(entry?.group);
    if (group === null || !isPlainObject(entry?.manifest)) continue;
    const path = variantProjectPath(entry, consumers);
    if (!path) continue;
    const paths = pathsByGroup.get(group) || new Set<string>();
    paths.add(path);
    pathsByGroup.set(group, paths);
  }
  return pathsByGroup;
}

function deliveryTargetsFor(
  name: string,
  entry: LooseRecord,
  consumers: MillConsumers,
  builtVariantPaths: Map<string, Set<string>>,
): MillDeliveryTarget[] {
  const group = stringOrNull(entry?.group);
  if (group !== null) {
    const path = variantProjectPath(entry, consumers);
    if (!path) return [];
    const variantProject = isPlainObject(entry?.variantProject) ? (entry?.variantProject as LooseRecord) : null;
    return [{ path, label: stringOrNull(variantProject?.label) || 'project' }];
  }
  const targets = consumers.targetsByPack.get(name) || [];
  const spec = isPlainObject(entry?.spec) ? (entry?.spec as LooseRecord) : null;
  if (spec === null || spec.perProjectVariants !== true) return targets;

  const covered = builtVariantPaths.get(name);
  if (!covered) return targets;
  return targets.filter((target) => !covered.has(target.path));
}

function pendingTargetsFor(
  name: string,
  entry: LooseRecord,
  consumers: MillConsumers,
  { specValid, built, manifest, packsDir, builtVariantPaths }: {
    specValid: boolean;
    built: MillBuild | null;
    manifest: unknown;
    packsDir: string | null;
    builtVariantPaths: Map<string, Set<string>>;
  },
): MillDeliveryTarget[] {
  if (!specValid || built === null || built.empty === true) return [];
  return deliveryTargetsFor(name, entry, consumers, builtVariantPaths)
    .filter((target) => decidePackDelivery({ manifest, projectPath: target.path, packsDir }).deliver);
}

function buildPackRow(
  entry: LooseRecord,
  { consumers, sessionRows, measurementByPack, packsDir, builtVariantPaths }: {
    consumers: MillConsumers;
    sessionRows: unknown;
    measurementByPack: LooseRecord;
    packsDir: string | null;
    builtVariantPaths: Map<string, Set<string>>;
  },
): MillPackRow {
  const name = String(entry?.name ?? '');
  const spec = isPlainObject(entry?.spec) ? (entry.spec as LooseRecord) : null;
  const manifest = isPlainObject(entry?.manifest) ? entry.manifest : null;
  const { valid, errors } = specErrorsFor(entry || {});
  const built = builtFrom(manifest);
  const pendingTargets = pendingTargetsFor(name, entry, consumers, { specValid: valid, built, manifest, packsDir, builtVariantPaths });
  const deliveredTo = deliveriesFor(name, sessionRows, built ? built.version : null, consumers.labelByPath, pendingTargets);
  const group = stringOrNull(entry?.group);

  const variantProject = group === null
    ? null
    : ((entry?.variantProject as { id?: unknown; label?: unknown } | null | undefined) || null);
  const namedBy = {
    projects: group === null
      ? (consumers.projectsByPack.get(name) || [])
      : [stringOrNull(variantProject?.label) || 'project'],

    lanes: group === null
      ? consumers.lanes.filter((lane) => lane.names.includes(name)).map((lane) => ({ kind: lane.kind, label: lane.label }))
      : [],
  };
  return {
    name,

    group,
    projectId: stringOrNull(variantProject?.id),
    description: stringOrNull(spec?.description) || stringOrNull((manifest as LooseRecord | null)?.description) || '',
    specValid: valid,
    specErrors: errors,
    sourceCount: countOf(spec?.sources),
    budgetTokens: numberOrNull(spec?.budgetTokens),
    built,
    builtReason: built ? null : shortBuiltReason(entry?.builtReason),
    deliveredTo,
    staleDeliveries: deliveredTo.reduce((total, delivery) => total + delivery.staleSessions, 0),
    consumers: namedBy,

    hasConsumers: namedBy.projects.length > 0 || namedBy.lanes.length > 0,
    distill: distillRowsFrom(entry?.distill),
    measurement: measurementByPack[name] ?? null,
  };
}

function totalsFrom(packs: MillPackRow[]): Record<string, number> {
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

function buildMillReport(input: {
  consumerSources?: unknown;
  specs?: unknown;
  sessionRows?: unknown;
  requestId?: unknown;
  ts?: unknown;
  autoRebuild?: unknown;
  distillerEnabled?: unknown;
  watcherCount?: unknown;
  measurementByPack?: unknown;
  packsDir?: unknown;
} | null | undefined): MillReport {
  const consumers = resolveConsumers(input?.consumerSources);
  const specs = asArray(input?.specs);
  const sessionRows = asArray(input?.sessionRows);
  const measurementByPack: LooseRecord = isPlainObject(input?.measurementByPack) ? (input?.measurementByPack as LooseRecord) : {};
  const packsDir = stringOrNull(input?.packsDir);
  const builtVariantPaths = builtVariantPathsByGroup(specs, consumers);
  const packs = specs.map((entry) => buildPackRow(entry, { consumers, sessionRows, measurementByPack, packsDir, builtVariantPaths }));

  const knownNames = new Set(packs.filter((pack) => pack.group === null).map((pack) => pack.name));
  return {
    type: 'mill-report',
    requestId: stringOrNull(input?.requestId),
    ts: safeNumber(input?.ts),
    autoRebuild: input?.autoRebuild === true,
    distillerEnabled: input?.distillerEnabled === true,
    watcherCount: numberOrNull(input?.watcherCount),

    projects: consumers.projects,
    maxPacksPerProject: MAX_PACKS_PER_SESSION,
    packs,
    configWarnings: [...consumers.warnings, ...unknownConsumerWarnings(consumers, knownNames)],
    totals: totalsFrom(packs),
    error: null,
  };
}

export {
  MAX_OUTPUT_ROWS,
  budgetPercent,
  buildMillReport,
  deliveriesFor,
  resolveConsumers,
  shortBuiltReason,
};
