// No watcher and no timer: the Visions relay already carries every notification this source maps.

'use strict';

const { applyEditorNotification, createEditorState } = require('./core/ingest-editor-core');
const { createLaneLog } = require('./lane-log');

/**
 * @param {{ publish: (event: Record<string, unknown>) => unknown,
 *   roots?: (() => string[]) | string[],
 *   logger?: Console, nowFn?: () => number, debug?: boolean | (() => boolean) }} options
 */
function createEditorIngest({
  publish,
  roots = () => [],
  logger = console,
  nowFn = Date.now,
  debug = false,
}) {
  const { debugNote, warn } = createLaneLog({ prefix: '[ingest:editor]', logger, debugFlag: debug });
  const publishEvent = publish;
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
    return publishEvent(applied.event);
  }

  function stop() {
    stopped = true;
    state = createEditorState();
  }

  return { name: 'editor', note, stop };
}

module.exports = { createEditorIngest };
