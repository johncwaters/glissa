const MAX_DAEMON_FRAME_BYTES = 2 * 1024 * 1024;

interface DaemonMessage {
  type: 'lsp';
  method: string;
  params: unknown;
}

interface MirrorDocument {
  uri: string;
  languageId?: string;
  version?: number;
  text?: string;
}

interface FrameDecision {
  send: boolean;
  serialized: string;
  frameBytes: number;
}

interface MirrorSyncInputs {
  method: string;
  isUnsynced: boolean;
  originalFrameFits: boolean;
  fullFrameFits: boolean;
}

interface MirrorSyncPlan {
  actions: string[];
  forgetUnsynced: boolean;
  markUnsynced: boolean;
  shouldLog: boolean;
}

function daemonMessage(method: string, params: unknown): DaemonMessage {
  return { type: 'lsp', method, params };
}

function replayDidOpenMessage(doc: MirrorDocument): DaemonMessage {
  return daemonMessage('textDocument/didOpen', {
    textDocument: {
      uri: doc.uri,
      languageId: doc.languageId,
      version: doc.version,
      text: doc.text,
    },
  });
}

function decideDaemonFrame(payload: unknown, maxFrameBytes = MAX_DAEMON_FRAME_BYTES): FrameDecision {
  const serialized = JSON.stringify(payload);
  const frameBytes = Buffer.byteLength(serialized, 'utf8');
  return {
    send: frameBytes <= maxFrameBytes,
    serialized,
    frameBytes,
  };
}

function planMirrorReplay(documents: unknown, maxFrameBytes = MAX_DAEMON_FRAME_BYTES): {
  frames: { uri: string; message: DaemonMessage; serialized: string }[];
  skipped: { uri: string; frameBytes: number }[];
} {
  const frames: { uri: string; message: DaemonMessage; serialized: string }[] = [];
  const skipped: { uri: string; frameBytes: number }[] = [];
  const mirrorDocuments: MirrorDocument[] = Array.isArray(documents) ? documents : [];
  for (const doc of mirrorDocuments) {
    const message = replayDidOpenMessage(doc);
    const decision = decideDaemonFrame(message, maxFrameBytes);
    if (!decision.send) {
      skipped.push({ uri: doc.uri, frameBytes: decision.frameBytes });
      continue;
    }
    frames.push({ uri: doc.uri, message, serialized: decision.serialized });
  }
  return { frames, skipped };
}

function decideMirrorSync(
  { method, isUnsynced, originalFrameFits, fullFrameFits }: MirrorSyncInputs,
): MirrorSyncPlan {
  if (method === 'textDocument/didClose') {
    return {
      actions: isUnsynced ? [] : ['original'],
      forgetUnsynced: true,
      markUnsynced: false,
      shouldLog: false,
    };
  }
  if (isUnsynced && !fullFrameFits) {
    return {
      actions: [],
      forgetUnsynced: false,
      markUnsynced: false,
      shouldLog: false,
    };
  }
  if (isUnsynced) {
    return {
      actions: ['full-open'],
      forgetUnsynced: false,
      markUnsynced: false,
      shouldLog: false,
    };
  }
  if (originalFrameFits) {
    return {
      actions: ['original'],
      forgetUnsynced: false,
      markUnsynced: false,
      shouldLog: false,
    };
  }
  return {
    actions: fullFrameFits ? ['close', 'full-open'] : ['close'],
    forgetUnsynced: false,
    markUnsynced: true,
    shouldLog: true,
  };
}

export {
  MAX_DAEMON_FRAME_BYTES,
  daemonMessage,
  decideDaemonFrame,
  decideMirrorSync,
  planMirrorReplay,
  replayDidOpenMessage,
};
export type { DaemonMessage, FrameDecision, MirrorDocument, MirrorSyncInputs, MirrorSyncPlan };
