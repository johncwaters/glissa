// Visions is one switch, so enabling it implies the lanes it needs rather than seven more toggles. The
// implied blocks are WRITTEN rather than derived at read time, or the dashboard would show sources off
// while they ran. Anything the operator already set, true or false, is never touched.

'use strict';

// Movement signals only. Terminal output and shell history are captured PROSE, so they stay opt-in: an
// implied default may widen what a lane watches, never what it records.
const IMPLIED_INGEST = Object.freeze({
  enabled: true,
  sources: Object.freeze({
    fs: Object.freeze({ enabled: true }),
    git: Object.freeze({ enabled: true }),
    editor: Object.freeze({ enabled: true }),
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Per SOURCE, not per block: an operator who enabled Visions before a source existed has an `ingest`
 * block that predates it, and a whole-block check would leave that source off forever. An ABSENT key is
 * not a choice; an explicit `false` is, and is never touched.
 */
function impliedIngestChanges(config) {
  if (!isPlainObject(config.ingest)) {
    return [{ path: ['ingest'], value: JSON.parse(JSON.stringify(IMPLIED_INGEST)), why: 'visions needs machine context' }];
  }
  const changes = [];
  if (config.ingest.enabled !== true && config.ingest.enabled !== false) {
    changes.push({ path: ['ingest', 'enabled'], value: true, why: 'visions needs machine context' });
  }
  if (config.ingest.enabled === false) return changes;
  const sources = isPlainObject(config.ingest.sources) ? config.ingest.sources : {};
  for (const [name, value] of Object.entries(IMPLIED_INGEST.sources)) {
    if (isPlainObject(sources[name])) continue;
    changes.push({ path: ['ingest', 'sources', name], value: { ...value }, why: `visions implies the ${name} source` });
  }
  return changes;
}

function decideImpliedDefaults(config) {
  if (config?.visions?.enabled !== true) return { changes: [] };
  const changes = impliedIngestChanges(config);
  if (!isPlainObject(config.visions.dispatch)) changes.push({ path: ['visions', 'dispatch'], value: { enabled: true }, why: 'visions implies its model dispatch' });
  return { changes };
}

function applyChanges(config, changes) {
  for (const change of changes) {
    let cursor = config;
    for (const key of change.path.slice(0, -1)) {
      if (!isPlainObject(cursor[key])) cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[change.path[change.path.length - 1]] = change.value;
  }
  return config;
}

module.exports = { IMPLIED_INGEST, applyChanges, decideImpliedDefaults };
