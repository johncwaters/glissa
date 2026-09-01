import { applyEditorNotification, createEditorState } from './core/ingest-editor-core.ts';
import type { EditorEvent } from './core/ingest-editor-core.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';

interface EditorIngestOptions {
  publish: (event: EditorEvent) => unknown;
  roots?: (() => string[]) | string[];
  logger?: LaneLogger | null;
  nowFn?: () => number;
  debug?: boolean | (() => boolean);
}

interface EditorIngestNotification {
  method?: string;
  uri?: string;
}

interface EditorIngest {
  name: string;
  note(notification: EditorIngestNotification | null | undefined): unknown;
  stop(): void;
}

function createEditorIngest({
  publish,
  roots = () => [],
  logger = console,
  nowFn = Date.now,
  debug = false,
}: EditorIngestOptions): EditorIngest {
  const { debugNote, warn } = createLaneLog({ prefix: '[ingest:editor]', logger, debugFlag: debug });
  const publishEvent = publish;
  let state = createEditorState();
  let stopped = false;

  function currentRoots(): string[] {
    if (typeof roots !== 'function') return Array.isArray(roots) ? roots : [];
    try {
      return roots() || [];
    } catch (error) {
      warn(`root lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  function note(notification: EditorIngestNotification | null | undefined): unknown {
    if (stopped) return null;
    const applied = applyEditorNotification(state, {
      method: notification?.method,
      uri: notification?.uri,
      roots: currentRoots(),
      now: nowFn(),
    });
    state = applied.state;
    const event = applied.event;
    if (!event) return null;

    debugNote(() => `${event.kind} ${event.summary}`);
    return publishEvent(event);
  }

  function stop(): void {
    stopped = true;
    state = createEditorState();
  }

  return { name: 'editor', note, stop };
}

export { createEditorIngest };
export type { EditorIngest, EditorIngestOptions };
