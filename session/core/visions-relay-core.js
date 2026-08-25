'use strict';

const MAX_DAEMON_FRAME_BYTES = 2 * 1024 * 1024;

function daemonMessage(method, params) {
  return { type: 'lsp', method, params };
}

function replayDidOpenMessage(doc) {
  return daemonMessage('textDocument/didOpen', {
    textDocument: {
      uri: doc.uri,
      languageId: doc.languageId,
      version: doc.version,
      text: doc.text,
    },
  });
}

function decideDaemonFrame(payload, maxFrameBytes = MAX_DAEMON_FRAME_BYTES) {
  const serialized = JSON.stringify(payload);
  const frameBytes = Buffer.byteLength(serialized, 'utf8');
  return {
    send: frameBytes <= maxFrameBytes,
    serialized,
    frameBytes,
  };
}

function planMirrorReplay(documents, maxFrameBytes = MAX_DAEMON_FRAME_BYTES) {
  const frames = [];
  const skipped = [];
  for (const doc of Array.isArray(documents) ? documents : []) {
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

function decideMirrorSync({ method, isUnsynced, originalFrameFits, fullFrameFits }) {
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

module.exports = {
  MAX_DAEMON_FRAME_BYTES,
  daemonMessage,
  decideDaemonFrame,
  decideMirrorSync,
  planMirrorReplay,
  replayDidOpenMessage,
};
