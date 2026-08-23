'use strict';

// Pure assembly stage of the context mill: spec validation, the glob matcher the walker uses, the
// token heuristic, and the plan (output files plus manifest) for one pack build. No IO and no clock,
// so `builtAt` is passed in the way the other cores take time. node:crypto is required only for
// createHash, which is deterministic and touches nothing outside this call.
//
// Determinism is the contract: the same spec plus the same file contents must yield byte-identical
// outputs, which is what makes the pack version a hash and a rebuild diffable.

const crypto = require('node:crypto');
const { isPlainObject } = require('./usage-number-core');

// A pack name becomes a directory name under <packsRoot>/built, so it stays a plain segment.
const PACK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SPEC_KEYS = new Set(['name', 'description', 'sources', 'rules', 'skills', 'budgetTokens', 'distill']);
const SOURCE_KEYS = new Set(['path', 'glob', 'exclude', 'optional']);
const SKILL_KEYS = new Set(['dir']);
const DISTILL_KEYS = new Set(['output', 'sources', 'instructions']);

// The heuristic, named in the manifest so nobody mistakes it for a tokenizer.
const CHARS_PER_TOKEN = 4;
const TOKEN_ESTIMATE_METHOD = 'chars-per-token-4';

// The discovery tier is the one to budget hardest (context rot bites the always-loaded bytes first),
// so the thin index has its own cap on top of the per-pack budget.
const MAX_INDEX_TOKENS = 1200;

// Per-session ceiling on delivered packs. Each pack's index is always-loaded context, so the count is
// the second budget the per-pack one cannot see; the overflow is dropped, never a refused spawn.
const MAX_PACKS_PER_SESSION = 4;

// How far into a `packs` array normalization will read before rejecting it whole. Generous next to the
// per-session cap, so every plausible hand edit is still judged entry by entry.
const MAX_PACK_ENTRIES_SCANNED = 64;

const MANIFEST_FILE = 'manifest.json';
const INDEX_FILE = 'CLAUDE.md';
const RULES_DIR = '.claude/rules';
const SKILLS_DIR = '.claude/skills';

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Rough size of a string in tokens. Deliberately crude; see TOKEN_ESTIMATE_METHOD. */
function estimateTokens(text) {
  return Math.ceil(String(text == null ? '' : text).length / CHARS_PER_TOKEN);
}

function splitSegments(p) {
  return String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0);
}

function segmentMatches(patternSegment, pathSegment) {
  let source = '^';
  for (const ch of patternSegment) {
    if (ch === '*') {
      source += '[^/]*';
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  // Case-insensitive on every platform: the operator writes these on Windows, and a matcher whose
  // verdict changed with the host would make builds non-reproducible.
  return new RegExp(`${source}$`, 'i').test(pathSegment);
}

function matchSegments(patternSegments, patternIndex, pathSegments, pathIndex) {
  if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;

  const segment = patternSegments[patternIndex];
  if (segment === '**') {
    for (let skipTo = pathIndex; skipTo <= pathSegments.length; skipTo++) {
      if (matchSegments(patternSegments, patternIndex + 1, pathSegments, skipTo)) return true;
    }
    return false;
  }

  if (pathIndex >= pathSegments.length) return false;
  if (!segmentMatches(segment, pathSegments[pathIndex])) return false;
  return matchSegments(patternSegments, patternIndex + 1, pathSegments, pathIndex + 1);
}

/**
 * Minimal glob match: `**` spans any number of segments, `*` and `?` stay inside one segment, every
 * other character is literal. Both sides are compared segment-wise, so separator style does not matter.
 */
function matchesGlob(pattern, filePath) {
  if (typeof pattern !== 'string' || typeof filePath !== 'string') return false;
  return matchSegments(splitSegments(pattern), 0, splitSegments(filePath), 0);
}

function unknownKeyErrors(obj, allowed, label) {
  const errors = [];
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`${label}: unknown key "${key}"`);
  }
  return errors;
}

function validateSource(source, index, errors, label = `sources[${index}]`) {
  if (!isPlainObject(source)) {
    errors.push(`${label} must be an object`);
    return;
  }
  errors.push(...unknownKeyErrors(source, SOURCE_KEYS, label));

  const hasPath = typeof source.path === 'string' && source.path.length > 0;
  const hasGlob = typeof source.glob === 'string' && source.glob.length > 0;
  if (hasPath && hasGlob) errors.push(`${label} must set exactly one of "path" or "glob", not both`);
  if (!hasPath && !hasGlob) errors.push(`${label} must set a non-empty "path" or "glob"`);

  if (source.optional !== undefined && typeof source.optional !== 'boolean') {
    errors.push(`${label}.optional must be a boolean`);
  }

  if (source.exclude === undefined) return;
  if (!Array.isArray(source.exclude)) {
    errors.push(`${label}.exclude must be an array of glob strings`);
    return;
  }
  for (const [i, pattern] of source.exclude.entries()) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      errors.push(`${label}.exclude[${i}] must be a non-empty string`);
    }
  }
}

function validateOptionalArray(spec, key, notAnArrayMessage, validateItem, errors) {
  const value = spec[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(notAnArrayMessage);
    return;
  }
  for (const [index, item] of value.entries()) validateItem(item, index, errors);
}

function validateRule(rule, index, errors) {
  if (typeof rule === 'string' && rule.trim().length > 0) return;
  errors.push(`rules[${index}] must be a non-empty string`);
}

function validateSkill(skill, index, errors) {
  const label = `skills[${index}]`;
  if (!isPlainObject(skill)) {
    errors.push(`${label} must be an object`);
    return;
  }
  errors.push(...unknownKeyErrors(skill, SKILL_KEYS, label));
  if (typeof skill.dir !== 'string' || skill.dir.length === 0) {
    errors.push(`${label}.dir must be a non-empty string`);
  }
}

/**
 * A distilled file is WRITTEN by an LLM lane, so its path is checked before that lane ever runs: it
 * must land under the packs directory, which means relative, no drive letter, no root anchor and no
 * `..` segment. The distiller re-checks the resolved path too; this is the gate that keeps a spec
 * carrying an escaping path from being loadable at all.
 */
function isPackRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  const segments = splitSegments(value);
  if (segments.length === 0) return false;
  return !segments.includes('..');
}

function validateDistillEntry(entry, index, errors) {
  const label = `distill[${index}]`;
  if (!isPlainObject(entry)) {
    errors.push(`${label} must be an object`);
    return;
  }
  errors.push(...unknownKeyErrors(entry, DISTILL_KEYS, label));

  if (!isPackRelativePath(entry.output)) {
    errors.push(`${label}.output must be a relative path inside the packs directory (no absolute path, no ".." segment)`);
  }
  if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
    errors.push(`${label}.sources must be a non-empty array of source objects`);
  }
  if (Array.isArray(entry.sources)) {
    for (const [i, source] of entry.sources.entries()) {
      validateSource(source, i, errors, `${label}.sources[${i}]`);
    }
  }
  if (typeof entry.instructions !== 'string' || entry.instructions.trim().length === 0) {
    errors.push(`${label}.instructions must be a non-empty string`);
  }
}

/** @returns {{ ok: boolean, errors: string[] }} */
function validatePackSpec(spec) {
  const errors = [];
  if (!isPlainObject(spec)) return { ok: false, errors: ['spec must be a JSON object'] };

  errors.push(...unknownKeyErrors(spec, SPEC_KEYS, 'spec'));

  if (typeof spec.name !== 'string' || !PACK_NAME_RE.test(spec.name)) {
    errors.push('name must be a plain directory-safe string (letters, digits, dot, dash, underscore)');
  }
  if (spec.description !== undefined && typeof spec.description !== 'string') {
    errors.push('description must be a string');
  }

  if (!Array.isArray(spec.sources) || spec.sources.length === 0) {
    errors.push('sources must be a non-empty array');
  }
  if (Array.isArray(spec.sources)) {
    for (const [index, source] of spec.sources.entries()) validateSource(source, index, errors);
  }

  validateOptionalArray(spec, 'rules', 'rules must be an array of strings', validateRule, errors);
  validateOptionalArray(spec, 'skills', 'skills must be an array of { dir } objects', validateSkill, errors);
  validateOptionalArray(spec, 'distill', 'distill must be an array of { output, sources, instructions } objects', validateDistillEntry, errors);

  if (!Number.isInteger(spec.budgetTokens) || spec.budgetTokens <= 0) {
    errors.push('budgetTokens must be a positive integer');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Normalize a project record's `packs` list into the names a spawn may deliver. Deliberately lenient:
 * a hand-edited config is the M2 interface, and a malformed entry must cost that entry, never the spawn.
 *
 * @returns {{ names: string[], warnings: string[] }} names in config order, deduped and count-capped
 */
function normalizePackNames(value, { maxPacks = MAX_PACKS_PER_SESSION } = {}) {
  if (value == null) return { names: [], warnings: [] };
  if (!Array.isArray(value)) return { names: [], warnings: ['packs must be an array of pack names; ignoring it'] };
  // One warning string per entry is the whole cost of reading this list, so an array far past the cap is
  // rejected whole rather than scanned: at that length it is a malformed config or a hostile frame, not
  // a pack list, and no per-entry verdict about it would be worth allocating.
  if (value.length > MAX_PACK_ENTRIES_SCANNED) {
    return { names: [], warnings: [`packs lists ${value.length} entries, far past the ${maxPacks} pack per session cap; ignoring it`] };
  }

  const names = [];
  const warnings = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || !PACK_NAME_RE.test(entry)) {
      warnings.push(`packs[${index}] is not a valid pack name; ignoring it`);
      continue;
    }
    if (names.includes(entry)) {
      warnings.push(`packs[${index}] repeats "${entry}"; ignoring the duplicate`);
      continue;
    }
    if (names.length >= maxPacks) {
      warnings.push(`packs[${index}] ("${entry}") is over the ${maxPacks} pack per session cap; ignoring it`);
      continue;
    }
    names.push(entry);
  }
  return { names, warnings };
}

// The ephemeral lanes that name packs, read once here so the gate and the Mill tab cannot enumerate a
// different set of config keys. `label` is how a warning names the key; the display prose belongs to the
// surface rendering it, not to a server core.
const PACK_CONSUMER_LANES = Object.freeze([
  { kind: 'prReview', label: 'prReview.packs', read: (config) => config?.prReview?.packs },
  { kind: 'posthog', label: 'posthog.packs', read: (config) => config?.posthog?.packs },
]);

/**
 * THE enumeration of everything that names packs: one row per project plus one per ephemeral lane. Both
 * the mill's build gate and the Mill tab's attribution derive from this single list, so a future third
 * pack-naming config key cannot reach one and miss the other.
 *
 * @returns {{ kind: string, id: string|null, label: string, packs: * }[]} raw lists, not yet normalized
 */
function packConsumerSources(config) {
  const sources = [];
  for (const project of Array.isArray(config?.projects) ? config.projects : []) {
    sources.push({
      kind: 'project',
      id: typeof project?.id === 'string' ? project.id : null,
      label: typeof project?.name === 'string' && project.name ? project.name : 'project',
      packs: project?.packs,
    });
  }
  for (const lane of PACK_CONSUMER_LANES) {
    sources.push({ kind: lane.kind, id: null, label: lane.label, packs: lane.read(config) });
  }
  return sources;
}

/**
 * Every pack name something would actually be spawned against. Normalized through the SAME rule a spawn
 * applies, so a name a spawn would drop is not a consumer either, and a pack nobody names is one the
 * mill need not build or watch.
 *
 * @returns {string[]} deduped and sorted, so it doubles as a change key
 */
function consumedPackNames(config) {
  const names = new Set();
  for (const source of packConsumerSources(config)) {
    for (const name of normalizePackNames(source.packs).names) names.add(name);
  }
  return [...names].sort();
}

/**
 * One project's pack list after a single delivery toggle. A DELTA rather than a whole-list replace for
 * two reasons: the current list is re-read from the config being written, so two dashboards toggling
 * different packs cannot clobber each other, and only the name being ADDED is ever checked against the
 * specs, so a list already naming a deleted spec stays editable instead of being frozen by its own ghost.
 *
 * The cap is enforced here rather than by normalization, because silently dropping the entry an operator
 * just ticked is the one outcome worse than refusing it.
 */
function applyPackDelta(currentPacks, packName, deliver, { maxPacks = MAX_PACKS_PER_SESSION } = {}) {
  const { names } = normalizePackNames(currentPacks, { maxPacks: Number.POSITIVE_INFINITY });
  if (deliver !== true) return { ok: true, packs: names.filter((name) => name !== packName) };
  if (names.includes(packName)) return { ok: true, packs: names };
  if (names.length >= maxPacks) {
    return { ok: false, error: `a project may deliver at most ${maxPacks} packs` };
  }
  return { ok: true, packs: [...names, packName] };
}

function sourcePattern(source) {
  return typeof source.glob === 'string' && source.glob.length > 0 ? source.glob : source.path;
}

/** Stable, readable name for a source group's rules file: ordinal plus the pattern's last literal segment. */
function sourceSlug(pattern, index) {
  const ordinal = String(index + 1).padStart(2, '0');
  let base = '';
  for (const segment of splitSegments(pattern)) {
    if (segment === '.' || segment === '..' || segment === '**') continue;
    if (segment.includes('*') || segment.includes('?')) continue;
    base = segment;
  }
  const slug = base
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `${ordinal}-${slug}` : ordinal;
}

function skillName(dir) {
  const segments = splitSegments(dir);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

function byRelPath(a, b) {
  if (a.relPath === b.relPath) return 0;
  return a.relPath < b.relPath ? -1 : 1;
}

function buildRulesFile(pattern, files) {
  const parts = [`<!-- Assembled by the Glissa context mill from ${pattern} -->`, ''];
  for (const [index, file] of files.entries()) {
    if (index > 0) parts.push('---', '');
    parts.push(`<!-- source: ${file.relPath} -->`, '', file.content.trim(), '');
  }
  return `${parts.join('\n').trim()}\n`;
}

function buildIndexFile(spec, groups, skills) {
  const parts = [`# ${spec.name}`, ''];
  if (spec.description) parts.push(spec.description, '');

  const rules = Array.isArray(spec.rules) ? spec.rules : [];
  if (rules.length > 0) {
    parts.push('## Rules', '');
    for (const rule of rules) parts.push(`- ${rule}`);
    parts.push('');
  }

  if (groups.length > 0) {
    parts.push('## Reference', '');
    for (const group of groups) {
      const tokens = estimateTokens(group.content);
      parts.push(`- \`${group.relPath}\` from \`${group.pattern}\` (${group.files.length} files, ~${tokens} tokens)`);
    }
    parts.push('');
  }

  if (skills.length > 0) {
    parts.push('## Skills', '');
    for (const skill of skills) parts.push(`- \`${SKILLS_DIR}/${skill.name}\``);
    parts.push('');
  }

  // Version and builtAt are deliberately absent: they live in manifest.json, and stamping them into a
  // delivered file would change the pack hash on every rebuild.
  parts.push('Assembled by the Glissa context mill. See `manifest.json` for version and build time.');
  return `${parts.join('\n').trim()}\n`;
}

function groupSourceFiles(spec, files, errors) {
  const groups = [];
  for (const [index, source] of spec.sources.entries()) {
    const pattern = sourcePattern(source);
    const matched = files.filter((file) => file.sourceIndex === index).sort(byRelPath);
    if (matched.length === 0) {
      // A source that matched nothing is a build error, because a silent hole in a pack is worse than
      // a loud failure. `optional: true` is the one exemption, for a file a distill lane has not
      // written yet: the pack still builds, just without that group.
      if (source.optional !== true) errors.push(`sources[${index}] (${pattern}) matched no files`);
      continue;
    }
    const slug = sourceSlug(pattern, index);
    groups.push({
      index,
      pattern,
      slug,
      relPath: `${RULES_DIR}/${slug}.md`,
      files: matched,
      content: buildRulesFile(pattern, matched),
    });
  }
  return groups;
}

function groupSkillFiles(spec, files, errors) {
  const skills = [];
  const declared = Array.isArray(spec.skills) ? spec.skills : [];
  for (const [index, skill] of declared.entries()) {
    const matched = files.filter((file) => file.skillIndex === index).sort(byRelPath);
    if (matched.length === 0) {
      errors.push(`skills[${index}] (${skill.dir}) has no files`);
      continue;
    }
    skills.push({ index, dir: skill.dir, name: skillName(skill.dir), files: matched });
  }
  return skills;
}

function classifyFiles(files, errors) {
  if (!Array.isArray(files)) {
    errors.push('files must be an array of { relPath, content, sourceIndex | skillIndex }');
    return false;
  }
  for (const [index, file] of files.entries()) {
    if (!isPlainObject(file) || typeof file.relPath !== 'string' || typeof file.content !== 'string') {
      errors.push(`files[${index}] must be { relPath, content } with string values`);
      continue;
    }
    const hasSource = Number.isInteger(file.sourceIndex);
    const hasSkill = Number.isInteger(file.skillIndex);
    if (hasSource === hasSkill) {
      errors.push(`files[${index}] (${file.relPath}) must carry exactly one of sourceIndex or skillIndex`);
    }
  }
  return errors.length === 0;
}

/**
 * Plan one pack build.
 *
 * @param {object} spec parsed pack spec
 * @param {Array<{relPath: string, content: string, sourceIndex?: number, skillIndex?: number}>} files
 *   files the shell already read: `sourceIndex` names the spec source that matched it, `skillIndex`
 *   the skill dir it came from (and then `relPath` is relative to that dir).
 * @param {{ builtAt: string }} options build stamp, supplied by the caller so this stays clock-free
 * @returns {{ ok: boolean, outputs: Array<{relPath: string, content: string}>, manifest: object|null, errors: string[] }}
 */
function planPackBuild(spec, files, { builtAt } = {}) {
  const specCheck = validatePackSpec(spec);
  if (!specCheck.ok) return { ok: false, outputs: [], manifest: null, errors: specCheck.errors };

  const errors = [];
  if (!classifyFiles(files, errors)) return { ok: false, outputs: [], manifest: null, errors };

  const groups = groupSourceFiles(spec, files, errors);
  const skills = groupSkillFiles(spec, files, errors);
  if (errors.length > 0) return { ok: false, outputs: [], manifest: null, errors };

  const outputs = [{ relPath: INDEX_FILE, content: buildIndexFile(spec, groups, skills) }];
  for (const group of groups) outputs.push({ relPath: group.relPath, content: group.content });
  for (const skill of skills) {
    for (const file of skill.files) {
      outputs.push({ relPath: `${SKILLS_DIR}/${skill.name}/${file.relPath}`, content: file.content });
    }
  }
  outputs.sort(byRelPath);

  const outputRecords = outputs.map((file) => ({
    relPath: file.relPath,
    sha256: sha256(file.content),
    tokenEstimate: estimateTokens(file.content),
  }));
  const tokenEstimate = outputRecords.reduce((total, file) => total + file.tokenEstimate, 0);
  const indexTokens = outputRecords.find((file) => file.relPath === INDEX_FILE).tokenEstimate;

  // The version covers every DELIVERED byte (sources, rules, description, skills), not just the source
  // hashes, so an edited rule cannot ride out under an unchanged version. manifest.json is excluded
  // because it carries builtAt.
  const version = sha256(outputRecords.map((file) => `${file.relPath}:${file.sha256}`).join('\n'));

  if (indexTokens > MAX_INDEX_TOKENS) {
    errors.push(`CLAUDE.md index is ~${indexTokens} tokens, over the ${MAX_INDEX_TOKENS} token index cap`);
  }
  if (tokenEstimate > spec.budgetTokens) {
    errors.push(`pack is ~${tokenEstimate} tokens, over its ${spec.budgetTokens} token budget`);
  }
  if (errors.length > 0) return { ok: false, outputs: [], manifest: null, errors };

  const manifest = {
    name: spec.name,
    description: spec.description || '',
    version,
    builtAt: typeof builtAt === 'string' ? builtAt : null,
    tokenEstimate,
    tokenEstimateMethod: TOKEN_ESTIMATE_METHOD,
    budgetTokens: spec.budgetTokens,
    budgetOk: true,
    indexTokenEstimate: indexTokens,
    rules: Array.isArray(spec.rules) ? [...spec.rules] : [],
    sources: groups.map((group) => ({
      pattern: group.pattern,
      exclude: [...(spec.sources[group.index].exclude || [])],
      rulesFile: group.relPath,
      files: group.files.map((file) => ({ relPath: file.relPath, sha256: sha256(file.content) })),
    })),
    skills: skills.map((skill) => ({
      dir: skill.dir,
      name: skill.name,
      files: skill.files.map((file) => ({ relPath: file.relPath, sha256: sha256(file.content) })),
    })),
    outputs: outputRecords,
  };

  outputs.push({ relPath: MANIFEST_FILE, content: `${JSON.stringify(manifest, null, 2)}\n` });
  return { ok: true, outputs, manifest, errors: [] };
}

module.exports = {
  INDEX_FILE,
  MANIFEST_FILE,
  MAX_INDEX_TOKENS,
  MAX_PACKS_PER_SESSION,
  PACK_NAME_RE,
  MAX_PACK_ENTRIES_SCANNED,
  applyPackDelta,
  consumedPackNames,
  estimateTokens,
  isPackRelativePath,
  packConsumerSources,
  matchesGlob,
  normalizePackNames,
  planPackBuild,
  sha256,
  sourcePattern,
  sourceSlug,
  validatePackSpec,
};
