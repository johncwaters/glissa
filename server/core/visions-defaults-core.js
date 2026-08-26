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

function decideImpliedDefaults(config) {
  if (config?.visions?.enabled !== true) return { changes: [] };
  const changes = [];
  if (!isPlainObject(config.ingest)) changes.push({ path: ['ingest'], value: JSON.parse(JSON.stringify(IMPLIED_INGEST)), why: 'visions needs machine context' });
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
