/*
 * Editor ingest source, IO shell (docs/plan-ingestion.md, M6 Sources). It owns no watcher and no timer:
 * the Visions relay already carries every editor notification, so this source is a mapper the lane calls
 * with what that relay reported. It publishes MARKERS only, never buffer text.
 */

'use strict';

const { applyEditorNotification, createEditorState } = require('./core/ingest-editor-core');
const { createLaneLog } = require('./lane-log');

function createEditorIngest({
  publish,
  roots = () => [],
  logger = console,
  nowFn = Date.now,
  debug = false,
} = {}) {
  const { debugNote, warn } = createLaneLog({ prefix: '[ingest:editor]', logger, debugFlag: debug });
  let state = createEditorState();
  let stopped = false;

  function currentRoots() {
    if (typeof roots !== 'function') return Array.isArray(roots) ? roots : [];
    try {
      return roots() || [];
    } catch (error) {
      warn(`root lookup failed: ${error.message}`);
      return [];
    }
  }

  function note(notification) {
    if (stopped) return null;
    const applied = applyEditorNotification(state, {
      method: notification?.method,
      uri: notification?.uri,
      roots: currentRoots(),
      now: nowFn(),
    });
    state = applied.state;
    if (!applied.event) return null;
    // Debug only: one line per open, save and close on every mirrored buffer.
    debugNote(() => `${applied.event.kind} ${applied.event.summary}`);
    return publish(applied.event);
  }

  function stop() {
    stopped = true;
    state = createEditorState();
  }

  return { name: 'editor', note, stop, get openCount() { return state.openUris.size; } };
}

module.exports = { createEditorIngest };
